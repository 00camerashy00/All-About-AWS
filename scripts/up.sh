#!/usr/bin/env bash
# First run asks for the host port and optional AWS keys, then starts Compose.
# Later runs reuse .env. Pass --setup to ask again.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

setup=0
if [[ "${1:-}" == "--setup" ]]; then
  setup=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./scripts/up.sh [--setup]" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Engine, then run this again." >&2
  exit 1
fi

quote_env() {
  local value="${1-}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

ask_setup() {
  local port="" answer="" access_key="" secret="" token="" region=""

  if [[ ! -t 0 ]]; then
    echo "No .env file, and this shell cannot ask questions. Run ./scripts/up.sh from a terminal." >&2
    exit 1
  fi

  read -r -p "Host port to publish [3003]: " port
  port="${port:-3003}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Use a port from 1 to 65535." >&2
    exit 1
  fi

  read -r -p "Store AWS keys in .env? [y/N]: " answer
  answer="${answer:-n}"
  case "${answer,,}" in
    y|yes)
      read -r -p "Access key ID: " access_key
      read -r -s -p "Secret access key: " secret
      echo
      read -r -s -p "Session token (empty for a long-lived key): " token
      echo
      read -r -p "Region [ap-south-1]: " region
      region="${region:-ap-south-1}"
      access_key="${access_key//[[:space:]]/}"
      secret="${secret//[[:space:]]/}"
      token="${token//[[:space:]]/}"
      if [[ -z "$access_key" || -z "$secret" ]]; then
        echo "Access key and secret are both required." >&2
        exit 1
      fi
      if [[ "$access_key" == ASIA* && -z "$token" ]]; then
        echo "Keys that start with ASIA need a session token." >&2
        exit 1
      fi
      if ! [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
        echo "Use a region code such as ap-south-1 or us-west-2." >&2
        exit 1
      fi
      ;;
    n|no) ;;
    *)
      echo "Answer y or n." >&2
      exit 1
      ;;
  esac

  umask 077
  {
    printf 'APP_PORT=%s\n' "$port"
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$(quote_env "$access_key")"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$(quote_env "$secret")"
    printf 'AWS_SESSION_TOKEN=%s\n' "$(quote_env "$token")"
    printf 'AWS_REGION=%s\n' "$(quote_env "${region:-ap-south-1}")"
  } > .env
  chmod 600 .env
}

if [[ ! -f .env || "$setup" -eq 1 ]]; then
  ask_setup
fi

docker compose up -d --build

port="$(sed -n 's/^APP_PORT=//p' .env | head -n 1 | tr -d '"')"
port="${port:-3003}"
echo "Dashboard is coming up on port ${port}. A restart does not repeat the last Rescan."
