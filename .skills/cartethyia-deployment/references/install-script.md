# `scripts/install/vps.sh`

One script, both topologies, both database modes. Idempotent — an existing
`.env` is never overwritten, and an existing checkout is updated in place.

```bash
# NAT VPS, full mode (Postgres)
curl -fsSL <raw-url>/scripts/install/vps.sh | bash -s -- --nat --full

# Regular VPS, full mode, Caddy issues the certificate
bash scripts/install/vps.sh --regular --full --domain app.example.com

# Lite mode (SQLite, no Postgres)
bash scripts/install/vps.sh --regular --lite --domain app.example.com
```

## Flags

| Flag | Meaning |
|---|---|
| `--nat` | Provider already terminates TLS. No proxy installed. |
| `--regular` | VM owns the public IP; installs Caddy and lets it issue. |
| `--full` | Postgres (default). |
| `--lite` | SQLite; no Postgres installed. |
| `--domain <host>` | Required with `--regular`; Caddy's site address, also sets `CARTETHYIA_PUBLIC_ORIGIN`. |
| `--skip-tls` | `--regular` without installing Caddy — you front it yourself. |

Env overrides: `CARTETHYIA_ROOT`, `CARTETHYIA_BRANCH`, `CARTETHYIA_PORT`,
`CARTETHYIA_REPO_URL`, `CARTETHYIA_DB_NAME`, `CARTETHYIA_DB_USER`.

## What it does

Packages → bun → clone/update → database (full only) → `.env` → install and
build → systemd → Caddy (regular only) → health check.

Two details worth knowing before you run it:

- **It builds the AOT artifact**, not a source run: `build:aot` then
  `build:binary`, and the unit's `ExecStart` is `dist/cartethyia`. That is why
  `NODE_ENV=production` is safe here — see
  [`gotchas.md`](gotchas.md). If you instead run `bun run src/main.ts`, set
  `CARTETHYIA_SOURCE_RUN=1`.
- **It refuses to guess a Postgres password.** If the role already exists, the
  script cannot know its password and dies with a message telling you to set
  `DATABASE_URL` yourself. This is deliberate: silently blanking it would
  produce a gateway that boots and then fails every DB write.

## Lite mode

Single-writer SQLite. `CARTETHYIA_DB_MODE=lite` and no Postgres. The data dir
is mounted writable in the unit, which is what
[`shared-provisioning.md`](shared-provisioning.md) requires regardless of mode.

## After it finishes

1. Open `/console` and finish the first-boot wizard.
2. Enroll an account — see [`verification.md`](verification.md).
3. Dispatch one real request. The script's health check proves the process is
   up; it does not prove upstream reachability.
