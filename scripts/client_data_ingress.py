import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

BUCKET = "krishagni-client-ingress"
REGION = "us-west-2"  # Change if your bucket is in a different AWS region

tty = open("/dev/tty", "r")

def prompt_user(label, example, default=None):
    suffix = f" [default: {default}]" if default else ""
    print(f"\n{label} (e.g., {example}){suffix}: ", end="", flush=True)
    val = tty.readline().strip()
    if not val and default is not None:
        return default
    while not val:
        print(f"  Value is required. {label} (e.g., {example}): ", end="", flush=True)
        val = tty.readline().strip()
    return val

def get_aws_credentials(profile=None):
    cmd = ["aws", "configure", "export-credentials", "--format", "process"]
    if profile:
        cmd.extend(["--profile", profile])
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.PIPE, text=True)
        return json.loads(out)
    except subprocess.CalledProcessError as e:
        print("\nERROR: Could not load AWS SSO credentials.", file=sys.stderr)
        print(f"Details: {e.stderr.strip()}", file=sys.stderr)
        print("Please run 'aws sso login' first and try again.", file=sys.stderr)
        sys.exit(1)

def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

def get_signature_key(secret_key, date_stamp, region_name, service_name):
    k_date = sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k_region = sign(k_date, region_name)
    k_service = sign(k_region, service_name)
    return sign(k_service, "aws4_request")

def main():
    profile = os.environ.get("AWS_PROFILE")
    creds = get_aws_credentials(profile)

    access_key = creds["AccessKeyId"]
    secret_key = creds["SecretAccessKey"]
    session_token = creds.get("SessionToken")

    customer = prompt_user("Enter customer name", "uva").strip("/")
    expires_raw = prompt_user("Enter link expiry in seconds", "3600 = 1 hr, 86400 = 24 hrs", default="86400")

    try:
        expires_in = int(expires_raw)
    except ValueError:
        print("Invalid number entered; defaulting to 86400 seconds (24 hours).")
        expires_in = 86400

    now = datetime.now(timezone.utc)
    date_seq = now.strftime("%Y%m%d-1")
    prefix = f"ingress/{customer}/{date_seq}/"

    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    credential = f"{access_key}/{date_stamp}/{REGION}/s3/aws4_request"
    expiration_iso = datetime.fromtimestamp(now.timestamp() + expires_in, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    conditions = [
        {"bucket": BUCKET},
        ["starts-with", "$key", prefix],
        {"success_action_status": "200"},
        {"x-amz-credential": credential},
        {"x-amz-algorithm": "AWS4-HMAC-SHA256"},
        {"x-amz-date": amz_date},
    ]
    if session_token:
        conditions.append({"x-amz-security-token": session_token})

    policy_doc = json.dumps({"expiration": expiration_iso, "conditions": conditions})
    policy_b64 = base64.b64encode(policy_doc.encode("utf-8")).decode("utf-8")

    signing_key = get_signature_key(secret_key, date_stamp, REGION, "s3")
    signature = hmac.new(signing_key, policy_b64.encode("utf-8"), hashlib.sha256).hexdigest()

    fields = {
        "success_action_status": "200",
        "key": f"{prefix}${{filename}}",
        "x-amz-algorithm": "AWS4-HMAC-SHA256",
        "x-amz-credential": credential,
        "x-amz-date": amz_date,
        "policy": policy_b64,
        "x-amz-signature": signature,
    }
    if session_token:
        fields["x-amz-security-token"] = session_token

    url = f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
    form_flags = " \\\n  ".join([f"-F '{k}={v}'" for k, v in fields.items()])

    client_cmd = (
        f'read -p "Enter file path to upload: " FILE_PATH && \\\n'
        f'curl -# --fail-with-body -w "\\nUpload Status: HTTP %{{http_code}}\\n" \\\n'
        f'  {form_flags} \\\n'
        f'  -F "file=@$FILE_PATH" "{url}"'
    )

    print("\n" + "=" * 70)
    print(f"Authorized Folder : s3://{BUCKET}/{prefix}")
    print(f"Expires In        : {expires_in} seconds")
    print("=" * 70)
    print(f"\nClient Upload Command (prompts for file path & uploads):\n\n{client_cmd}\n")

if __name__ == "__main__":
    main()
