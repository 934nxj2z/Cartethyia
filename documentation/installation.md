# Installation

Install variants for Cartethyia beyond the local path. For the canonical
install, requirements, mode choice, encryption key, Docker, and
verification, read [getting started](getting-started.md) first; this page
only covers VPS/systemd, the reverse-proxy wiring, and the one-shot script.

> [!WARNING]
> Cartethyia holds provider credentials and API keys on the machine you run it
> on. Restrict who can reach the console, and keep backups somewhere you control.

## VPS install — Lite (native, no Docker)

Verified on Debian 13, 1 vCPU / 2 GB, Bun 1.4.2.

```bash
# 1. Dependencies
apt-get update && apt-get install -y git curl unzip ca-certificates openssl

# 2. Bun
curl -fsSL https://bun.sh/install | bash
export PATH="/root/.bun/bin:$PATH"

# 3. Source
mkdir -p /opt/cartethyia/data
cd /opt/cartethyia
git clone -b dev https://github.com/risunCode/Cartethyia.git repo
cd repo

# 4. Configure
cp .env.example .env
cat >> .env <<EOF
CARTETHYIA_DB_MODE=lite
NODE_ENV=production
LOG_LEVEL=warn
PORT=8080
CARTETHYIA_ENCRYPTION_KEY=$(openssl rand -hex 32)
CARTETHYIA_PUBLIC_ORIGIN=https://your.domain
CARTETHYIA_DATA_DIR=/opt/cartethyia/data
CARTETHYIA_TELEMETRY_PAYLOAD_DIR=/opt/cartethyia/data/telemetry-payloads
CARTETHYIA_INSTALL_ID_DIR=/opt/cartethyia/data/.cartethyia
EOF

# 5. Build
bun install --linker isolated
bun run build
```

### systemd

`/etc/systemd/system/cartethyia.service`, then `systemctl enable --now cartethyia`:

```ini
[Service]
Type=simple
WorkingDirectory=/opt/cartethyia/repo
EnvironmentFile=/opt/cartethyia/repo/.env
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/cartethyia/repo/dist/cartethyia
Restart=always
RestartSec=5
```

Check it with `curl http://127.0.0.1:8080/health/ready`.

### Reverse proxy

Caddy: `your.domain { reverse_proxy 127.0.0.1:8080 }`.

Nginx must forward the client IP or every request looks like one IP:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
```

And set `TRUSTED_PROXY_CIDRS=127.0.0.1/32,10.0.0.0/8` in `.env`.

### Auto-deploy

Use [`scripts/install/lite.sh`](#one-shot-install-script) rather than writing
your own. If you do poll for updates, a build takes 3–5 minutes on 1 vCPU, so a
1-minute cron stacks builds until the box runs out of memory. Poll every 5
minutes, take a `flock` before fetching, and roll back to the previous commit if
`/health/ready` never comes up after the restart.

### Port

`PORT` is the one public port; the default is 12800. A VPS whose NAT does not
forward it should set `PORT` to a forwarded port and set
`CARTETHYIA_PUBLIC_ORIGIN` to the same port, or OAuth callbacks miss. The
dashboard dev server on 5173 is local only. The app binds `0.0.0.0`; Docker
maps `${PORT:-12800}` to the container's 12800, so changing `PORT` changes the
host side only.

## VPS install — Full (native)

Same as VPS Lite through step 5, then:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
REDIS_URL=redis://localhost:6379
```

Install PostgreSQL:

```bash
apt-get install -y postgresql
sudo -u postgres createdb cartethyia
```

`bun doctor` validates `.env`, backend reachability, optional Redis, and
readiness. Run it after any Full-mode change.

Multiple instances are supported in Full mode. Put them behind a load balancer
and keep `REDIS_URL` shared.

## Docker — bundling PostgreSQL

[Getting started](getting-started.md#7-docker) covers the default Compose stack,
which is Full mode with bundled Redis and an external PostgreSQL reached
through `DATABASE_URL`. To bundle PostgreSQL in Compose instead of pointing at
an external one, add a `docker-compose.override.yml` with a `postgres:16-alpine`
service, a `pg_isready` healthcheck, and `app.depends_on` waiting for it.
Mount its data on a named volume.

## One-shot install script

[`scripts/install/lite.sh`](https://github.com/risunCode/Cartethyia/blob/dev/scripts/install/lite.sh)
— one command, Lite mode, no manual steps. Idempotent; safe to re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/risunCode/Cartethyia/dev/scripts/install/lite.sh | bash
# or, from a checkout:
bash scripts/install/lite.sh
```

That script is the canonical one-shot installer; it installs system packages and
Bun, clones the repository, then hands off to the same wizard and build every
other path uses (`bun install --linker isolated` →
`bun run setup --non-interactive` → `bun run build`) and finishes with a
systemd unit. An existing `.env` is never overwritten.

Environment overrides: `CARTETHYIA_ROOT`, `CARTETHYIA_BRANCH`,
`CARTETHYIA_PORT`, `CARTETHYIA_PUBLIC_ORIGIN`.

**NEXT after install:** the console first-boot wizard has not run yet. Open
`$ORIGIN/console`, or seed it non-interactively:

```bash
curl -s http://127.0.0.1:$PORT/console/api/auth/first-boot
curl -s -X POST http://127.0.0.1:$PORT/console/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"password":"CHANGE-ME","username":"admin"}'
```

## See also

Endpoints, the encryption key, backups, and moving Lite to Full are covered in
[getting started](getting-started.md). Do not keep a second copy here.
