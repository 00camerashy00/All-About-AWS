# AWS Management Dashboard

Simple, clean, minimal AWS dashboard that translates technical AWS metrics into plain-English insights for management.

## Screens

- `/` redirects to Overview
- `/overview` — resource health and what needs a decision. Demo data until Rescan on that page
- `/resources` — EC2, RDS, S3, disks, snapshots, and network inventory with search and filters
- `/resources/[id]` — utilization and a plain-English recommendation for one resource
- `/users` — SSM users and SSO users in separate lists (demo data until Rescan on that page)
- `/monitoring` — EC2, RDS, and S3 health lists (separate tables, demo data until Rescan on that page)
- `/alarms` — CloudWatch alarms in plain English, one list per service (demo data until Rescan on that page)

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3003. The port is pinned in both the `dev` and `start` scripts.

Production:

```bash
npm run build
npm start
```

## Docker

On the Ubuntu VM, install Docker Engine and enable it so a reboot starts the containers again:

```bash
sudo systemctl enable --now docker
```

Clone this repo, then from the repo root:

```bash
./scripts/up.sh
```

The first run asks which host port to publish (default 3003) and whether to store AWS keys in `.env`. Answering no starts the dashboard on demo data. The secret is not printed. `.env` stays on the VM disk, mode `600`, and is not committed.

The container always listens on port 3003. Only the published host port changes. `restart: unless-stopped` brings that container back after a crash or a reboot. A restart does not repeat the last Rescan.

To change the port or the keys:

```bash
./scripts/up.sh --setup
```

## Data

The dashboard starts on demo data from `lib/mock-data.ts` until `.env.local` has `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`. Temporary keys (access key starting with `ASIA`) also need `AWS_SESSION_TOKEN`. The file is loaded by the server and the secret is never sent to the browser.

Loading the file does not scan AWS. Each page has its own Rescan button, and only that click calls its API: Overview and Resources use `GET /api/resources?refresh=1`, Users uses `GET /api/users?refresh=1`, Monitoring uses `GET /api/monitoring?refresh=1`, and Alarms uses `GET /api/alarms?refresh=1`. Read-only policies: `iam/users-readonly.json`, `iam/monitoring-readonly.json`, `iam/alarms-readonly.json`.

Alarms read `DescribeAlarms` and `DescribeAlarmHistory`. Sentences are templates, not parsed emails. History is limited to 14 days. Cache TTL is `ALARMS_CACHE_TTL_MS` (default 2 minutes). `ALARMS_REGIONS` or `MONITORING_REGIONS` can limit the scan. The module does not create, edit, or silence alarms.

Monitoring asks CloudWatch `GetMetricData` for one `Average` over the whole window (24 hours, 7, 14, or 30 days). It does not average raw points in the app. S3 size and object count are the latest daily storage metric. Results cache in memory (`MONITORING_CACHE_TTL_MS`, default 6 hours). `MONITORING_REGIONS` is an optional comma-separated allow-list.

## Notes

- Rename on Resources is a local demo. Live mapping: EC2 Name tag, RDS instance identifier. S3 buckets cannot be renamed.
- The first Rescan of Resources can take 1–2 minutes. A later visit reuses that result until Rescan is clicked again.
