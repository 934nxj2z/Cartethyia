# Shared provisioning (regular VPS and NAT VPS)

Everything up to and including the systemd unit is identical on both bare-metal
shapes. Only TLS ownership differs, and that lives in
[`regular-vps.md`](regular-vps.md) / [`nat-vps.md`](nat-vps.md).

## Packages

```bash
apt-get update && apt-get install -y \
  git curl unzip ca-certificates postgresql postgresql-contrib

# bun to /usr/local/bin — /root/.bun/bin is blocked by ProtectHome, see gotchas.md
curl -fsSL https://bun.sh/install | bash
cp -f /root/.bun/bin/bun /usr/local/bin/bun
bun --version
systemctl enable --now postgresql
```

## Postgres

```bash
runuser -u postgres -- psql -c "CREATE ROLE cartethyia LOGIN PASSWORD '<generated>'"
runuser -u postgres -- createdb -O cartethyia cartethyia
```

Use `runuser -u postgres --`, not `su - postgres -c` — the latter prints the
login MOTD and swallows query output, so a `||`-chained "create role if absent"
script silently no-ops. Verify afterwards:

```bash
runuser -u postgres -- psql -tAc "SELECT rolname FROM pg_roles WHERE rolname='cartethyia'"
runuser -u postgres -- psql -tAc "SELECT datname FROM pg_database WHERE datname='cartethyia'"
```

## Checkout and build

```bash
git clone --depth 1 --branch <tag-or-main> <repo> /opt/cartethyia
cd /opt/cartethyia && bun install --frozen-lockfile && bun run dashboard:build
```

**Build order matters.** `bun run dashboard:build` must run before the service
starts: the gateway serves `dist/dashboard` from `DASHBOARD_DIST` and there is
no runtime fallback.

Note the branch you actually deployed — `git log --oneline -1` after cloning,
because `--depth 1 --branch` on a moving branch can land anywhere.

## Environment (`/opt/cartethyia/.env`, mode `0600`)

Generate every secret on the host. Never copy an env file from another
deployment — especially `CARTETHYIA_ENCRYPTION_KEY`, which invalidates every
stored credential when it changes.

```dotenv
PORT=8080
DASHBOARD_DIST=/opt/cartethyia/dist/dashboard
CARTETHYIA_PUBLIC_ORIGIN=https://<domain>
# The reverse proxy talks over loopback, so only loopback may assert a client IP.
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://cartethyia:<generated>@127.0.0.1:5432/cartethyia
# One instance means in-process coordination is correct; `normal` requires Redis.
REDIS_MODE=disabled
CARTETHYIA_ENCRYPTION_KEY=<base64 of 32 random bytes>
CARTETHYIA_API_KEY=carte_<generated>
```

```bash
chmod 600 /opt/cartethyia/.env && mkdir -p /opt/cartethyia/data
```

Notes:

- `CARTETHYIA_PUBLIC_ORIGIN` must carry the same scheme the browser uses. An
  `http://` origin behind an HTTPS front door makes OAuth redirect URIs wrong.
- Do **not** set `NODE_ENV=production` on a source-run service unless you also
  set `CARTETHYIA_SOURCE_RUN=1` — see [`gotchas.md`](gotchas.md). The bundled
  binary is unaffected. The logger already emits JSON whenever stdout is not a
  TTY, so leaving `NODE_ENV` unset costs little.
- `CARTETHYIA_DB_MODE=full` reads `DATABASE_URL`; migrations run at boot from
  `migrations/full-postgres/`.
- A duplicated `PORT` makes the last one win silently. After editing,
  `grep -c '^PORT='` and expect exactly `1`; confirm with `ss -lnt` rather than
  the config file.

## systemd unit (`/etc/systemd/system/cartethyia.service`)

```ini
[Unit]
Description=Cartethyia AI gateway
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/cartethyia
EnvironmentFile=/opt/cartethyia/.env
ExecStart=/usr/local/bin/bun run /opt/cartethyia/src/main.ts
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/cartethyia/data /opt/cartethyia/.env
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

`ReadWritePaths` is load-bearing: the gateway writes telemetry and payload
capture under `data/`, and a read-only filesystem without that carve-out fails
at first write.

`ProtectHome=true` is why bun must live in `/usr/local/bin`.

```bash
systemctl daemon-reload && systemctl enable cartethyia && systemctl start cartethyia
```

## First boot

The first boot seeds the schema and logs:

```
[setup] CARTETHYIA_API_KEY is set but no console user exists yet; complete the
first-boot wizard at /console so the key is seeded
```

That is expected, not a failure. Open `/console` and finish the wizard, which
then seeds the key.

If `GET /console/api/auth/first-boot` already reports `requires_setup: false`,
a backup was restored during provisioning — do not re-run setup; it returns
`400 Setup already completed`. Recover the console password through
`src/console/auth/account-reset.ts` instead.
