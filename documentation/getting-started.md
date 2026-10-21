# Getting started

This guide is the source of truth for installing, configuring, running, and
checking Cartethyia.

## 1. Requirements

All local installs require:

- Bun 1.4.0 or newer;
- a terminal;
- a writable data directory.

The database requirement depends on the selected mode:

| Mode | Required database infrastructure |
|---|---|
| **Lite** | None. Cartethyia runs embedded SQLite locally. |
| **Full** | A reachable PostgreSQL database configured with `DATABASE_URL`. |

Redis is optional in both modes. Set `REDIS_URL` when coordination must be
shared between processes or instances. If it is unset, Cartethyia uses the
in-memory coordination backend.

## 2. Choose a database mode

Same features either way. Only the database changes.

| | Lite | Full |
|---|---|---|
| Database | Embedded SQLite | External PostgreSQL |
| Best for | One person, one machine | VPS, several people, sustained load |
| Needs | Nothing | A reachable PostgreSQL |
| Ceiling | Single process, single writer | Multiple instances |

Lite is the default written by `bun setup` and shipped in `.env.example`, and it
stores its database at
`<CARTETHYIA_DATA_DIR>/cartethyia.sqlite`. When that is unset: `%APPDATA%\Cartethyia`
on Windows, `~/Library/Application Support/Cartethyia` on macOS,
`$XDG_DATA_HOME/Cartethyia` (or `~/.local/share/Cartethyia`) on Linux.

Full:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
```

Redis is optional in both. Set `REDIS_URL` only when coordination is shared
across processes. Lite is not a cut-down edition: move to Full later by
exporting a JSON backup and importing it. The config does not need rebuilding.

## 3. npm global package

```bash
npm install -g cartethyia
cartethyia setup
carte
```

`-g` (npm's alias for `--global`) is required. A local `npm install cartethyia`
installs the package but leaves `cartethyia` and `carte` in
`./node_modules/.bin/`, which is not on `PATH`, so neither command resolves.
For a local install run `npx cartethyia` instead. On Linux and macOS a global
install may need `sudo`; if it does, see
<https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally>.

Update and uninstall use the same flag:

```bash
npm update -g cartethyia    # update
npm uninstall -g cartethyia # uninstall
```

Updating prints a command instead of running one, because npm cannot replace
the package directory while a process is executing out of it — on Windows the
rename fails with `EBUSY`. Stop the gateway, run the printed command, then
start again.

Setup creates the encryption key, asks Lite or Full, checks the database, and
stores `.env` in the OS config directory (`%APPDATA%\Cartethyia` on Windows,
`~/Library/Application Support/Cartethyia` on macOS, `$XDG_CONFIG_HOME/Cartethyia`
on Linux). Override it with `CARTETHYIA_CONFIG_DIR`. Generated config and SQLite
data stay outside the npm package. Setup does not install PostgreSQL.

`carte` starts the gateway and opens an arrow-key menu: **Open Console**,
**Settings**, **Hide to background**, **Check for updates**, and **Exit**. It
needs no desktop environment, so it works over SSH and on a headless box.
`carte --tray` starts a system-tray icon instead — versions, **Open Console**,
**Reset password**, **Backup**, and **Exit** — and needs a graphical
session; the launcher then releases the terminal once the gateway is ready.
`cartethyia start` stays in the foreground. Exit drains the gateway through its
authenticated loopback endpoint before stopping. This does not install a
login/startup service.

`cartethyia setup --non-interactive` never prompts and reads the persisted
config. Full mode must already have `CARTETHYIA_DB_MODE=full` and a reachable
`DATABASE_URL` there; values supplied only in the shell are not copied to disk.
## 4. Install dependencies

From the repository root, install both Bun workspaces (backend and dashboard):

```bash
bun install --linker isolated
```

The isolated linker creates dependency directories for both the repository
root and `dashboard/`; one command installs both workspaces. Do not run a
separate install from `dashboard/`. Installation does not create the database,
generate `.env`, or start Cartethyia.

## 5. Configure and validate the installation

Run the unified setup command:

```bash
bun setup
```

`bun setup` refuses Bun older than 1.4.0, creates `.env` from `.env.example`,
generates `CARTETHYIA_ENCRYPTION_KEY` when missing, asks Lite or Full, probes
ports 12800, 8080, 3000, and 8081 and asks which to use, prepares the Lite data
directory or asks for `DATABASE_URL` in Full, and checks Redis only when
`REDIS_URL` is set. It does not install PostgreSQL and it does not start the
gateway. After it, open the console and finish the first-boot wizard.

`CARTETHYIA_DB_MODE` has no default: the gateway throws at boot when it is
absent, because the two modes are different databases and a silent guess would
pick which one an install's data is read against.

```bash
bun setup --non-interactive   # never prompts; fails when Full config is missing
bun doctor                    # checks .env, the database, optional Redis, readiness
```
## 6. Configure encryption

`CARTETHYIA_ENCRYPTION_KEY` is a required 256-bit secret. It encrypts stored
provider credentials and API keys. Treat it like a password and keep it outside
version control.

The setup command generates it. Generate one yourself only when rotating:

```bash
openssl rand -hex 32
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

A 64-character hex value or Base64 of 32 bytes are both accepted.

## 7. Start Cartethyia

Production builds first, then runs the compiled binary:

```bash
bun run build && bun run start
```

`bun run start` stops with "binary is missing" if you skip the build.
Development needs no build and hot-reloads: `bun run dev`. Split processes with
`bun run dev:backend` and `bun run dashboard:dev`, or `bun run dev:watch` to
restart on file changes.

Open `http://localhost:<PORT>/console`. Both forms listen on the same `PORT`
(12800 unless setup was told otherwise). The dashboard dev server on 5173
proxies to it and never needs to be opened on a VPS. When `PORT` changes,
`CARTETHYIA_PUBLIC_ORIGIN` must use it too, or OAuth callbacks miss.

| Endpoint | Purpose |
|---|---|
| `/health`, `/health/ready` | Liveness, and database/migration readiness |
| `/metrics` | Prometheus |
| `/v1/*` | Gateway API |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

## 8. Docker

Docker Compose defaults to Full mode and bundled Redis coordination:

```bash
docker compose up --build -d
docker compose logs -f app
```

Stop the stack with:

```bash
docker compose down
```

Full mode requires an external PostgreSQL reachable through `DATABASE_URL`; the
Compose file does not bundle PostgreSQL. Inside Compose, Redis uses the
Compose-only `CARTETHYIA_REDIS_URL`, because `environment` wins over `env_file`.
A host-oriented `REDIS_URL=redis://localhost:6379` in `.env` therefore cannot
leak into the container. To run the app container with Lite:

```dotenv
CARTETHYIA_DB_MODE=lite
# DATABASE_URL is not needed in Lite mode.
# CARTETHYIA_REDIS_URL=  # omit or leave empty for in-memory coordination
```

The Compose app stores gateway state and telemetry payloads in the persistent
`/app/data` volume. Redis starts as a helper container in either mode, but the
application uses the in-memory backend when `CARTETHYIA_REDIS_URL` is empty.

## 9. Migrations and backups

Numbered migrations under `migrations/full-postgres/` (Full) and
`migrations/lite-sqlite3/` (Lite) run automatically at boot and are
recorded in `cartethyia_schema_migrations`.

To move an installation from Lite to Full:

1. open the Lite dashboard;
2. export a backup from **Settings → Backup**;
3. configure and start the Full instance with an empty or new database;
4. wait for `/health/ready` to return HTTP `200`;
5. import the backup in the Full dashboard.

Backups may contain provider credentials and API-key data. Treat them like
passwords and store them securely.

## 10. Test database

Database-backed tests use the disposable URL in `CARTETHYIA_TEST_DATABASE_URL`,
not the runtime `DATABASE_URL`. Keep optional test service settings in the
existing local `.env` (created from `.env.example`) or export them in your
shell; there is no separate test env file. The backend suite requires
`CARTETHYIA_TEST_DATABASE_URL`; dashboard tests do not need a database.

Check the test database:

```bash
bun run test-db:check
```

If local PostgreSQL is unavailable, use the disposable test database in Compose
and add its URL to your existing `.env`:

```bash
bun run test-db:up
```

```dotenv
CARTETHYIA_TEST_DATABASE_URL=postgres://cartethyia_test:cartethyia_test@127.0.0.1:55432/cartethyia_test
```

Then run:

```bash
bun run test-db:check
bun run test:backend
bun run test-db:down
```

Never use production data for tests.

## 11. Verification commands

Run the gates relevant to the change:

```bash
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run test:backend
bun run dashboard:test
bun run build
```

Typechecking is not runtime proof. For behavior changes, also exercise the real
boundary: a gateway request, a browser surface, a provider flow, or an isolated
database migration.

### Do not run `bun test` directly

`bun test` is defined, but it is not the gate — it skips the runner, and the
runner is what makes the TLS-dependent suites pass. `scripts/ci/run.ts` merges
`test/fixtures/localhost-cert.pem` into a bundle and passes it to the subprocess
as `NODE_EXTRA_CA_CERTS`. Bun reads that variable only at process start, so a
direct `bun test` has no extra CA and the outbound HTTP/2 suites fail on the
handshake. Use `bun run test`, or `bun run test:backend` / `bun run
dashboard:test` for one scope.
