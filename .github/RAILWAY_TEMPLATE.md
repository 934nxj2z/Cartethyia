# Railway template

Config and documentation for deploying Cartethyia on Railway, modelled on the
9Router template: one service, one volume at `/app/data`, one public domain, and
a generated secret so a deploy needs no manual variables.

The app itself is untouched — no `src/` change, no dependency change. Upstream's
`docker-compose.yml`, `.env.example`, `.gitattributes` and source tree are
byte-identical; only the container files listed below differ, and every change
in them is marked `# Railway:`.

## Added files

| File | Purpose |
| --- | --- |
| `railway.json` | Dockerfile build, `/health/ready` check, `ALWAYS` restart with 10 retries, `numReplicas: 1`, `drainingSeconds: 40` so in-flight streams finish before SIGKILL |
| `.env.railway` | Defaults a standalone deploy boots with, plus placeholders. Holds no secret |
| `.railway/railway.ts` | Optional Infrastructure-as-Code mirror (`railway config plan` / `apply`) |
| `DEPLOY.md` | Overview copy for the Railway template page |
| `.hadolint.yaml` | Two documented linter exceptions for the Dockerfile |
| this page | The summary you are reading |

## Changed container files

| File | Change and why |
| --- | --- |
| `Dockerfile` | `CMD` uses an absolute path; `oven/bun:1.4.2-alpine` and `alpine:3.22` pinned instead of `:alpine`/`:latest`; `su-exec` replaces util-linux `setpriv`; `ca-certificates` added; `CARTETHYIA_TELEMETRY_PAYLOAD_DIR` moved onto the volume; longer healthcheck start period for the first-boot migration; copies `.env.railway` in as the boot fallback |
| `docker-entrypoint.sh` | Adds the `.env.railway` fallback, loaded *under* the real environment. A placeholder value stops the boot with a clear message instead of starting with a known encryption key |
| `.dockerignore` | Allowlist instead of a denylist. The old `.env*` rule dropped `.env.railway` from the build context, so the fallback would silently be missing and a standalone deploy could not boot |
| `.gitignore` | One negation (`!.env.railway`), because the tracked fallback is otherwise ignored by `.env.*` |

## Why `.env.railway` is safe to publish

`railway.json` cannot declare variables. A deploy that builds this repository
alone (dashboard "Deploy from GitHub", `railway up`) would otherwise start with
no `CARTETHYIA_ENCRYPTION_KEY` and crash. The file therefore carries defaults and
a **placeholder** key whose prefix is `replace-with-`; the entrypoint treats that
as "missing" and refuses to start. Real values come from Railway service
variables, which always win over the file.

## Before publishing the template

Run one real build, which no local check can substitute for:

```bash
docker build -t cartethyia-railway:local .
```

Then deploy through the template and confirm `/health/ready` turns green and
`/console` loads. See `README.md` in this repository for the template's
variables and volume settings.
