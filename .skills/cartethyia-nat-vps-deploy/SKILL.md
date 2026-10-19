---
name: cartethyia-nat-vps-deploy
description: "Deploy Cartethyia to a NAT'd VPS (Dahono Cloud and similar) behind the provider-managed Caddy Auto-SSL. Use when the domain resolves but HTTPS fails, when :80/:443 behave unexpectedly, or when provisioning a fresh NAT VPS end to end."
---

# Deploying to a NAT VPS (provider-managed Caddy)

A "NAT VPS" (Dahono Cloud, Narwhal, and similar cheap Indonesian/Chinese hosts)
is an LXC container on a **private** address with a limited set of public ports
forwarded by the host. This changes the deployment shape in ways that are not
obvious, and guessing wastes hours. Diagnose before you build.

## 1. Establish the topology first

Never assume the VM owns the public IP. Check, in this order:

```bash
# Inside the VM: what address does it actually hold?
ip -4 addr show scope global | grep inet
ip route | head -3
# What is the egress address the world sees?
python3 -c "import urllib.request;print(urllib.request.urlopen('https://api.ipify.org',timeout=8).read().decode())"
```

If the VM holds `10.x`/`192.168.x` but egress is a public IP, you are behind
NAT. The public IP is the host's, not yours.

Then find which ports actually reach you, **from outside** (not from the VM —
inside, everything binds fine and tells you nothing):

```bash
for p in 22 80 443 8080; do timeout 6 bash -c "echo > /dev/tcp/<PUBLIC_IP>/$p" 2>/dev/null \
  && echo "$p OPEN" || echo "$p CLOSED"; done
```

Corroborate by binding a throwaway listener inside and probing it from outside.
A port can bind locally yet be unreachable, so the outside probe is the only
answer that counts.

## 2. The provider almost certainly runs its own Caddy

Providers like this advertise "Caddy Auto-SSL & subdomain gratis". That means a
Caddy already occupies `:80`/`:443` **and terminates TLS for you**.

```bash
systemctl list-unit-files | grep -i caddy
systemctl is-active caddy
```

Consequences that matter:

- **Do not install a second reverse proxy.** You will fight the provider's for
  the ports.
- **Do not set `local_certs`.** It swaps the public certificate for a private
  one; the browser then rejects the site and ACME never issues. This is the
  single most expensive mistake in this setup — the symptom is
  `https=000` from outside while `openssl s_client` shows a cert issued by
  `Caddy Local Authority`.
- **Do not disable the 80→443 redirect** to "fix" an ACME challenge. If :443 is
  forwarded, tls-alpn-01 and http-01 both work; suppressing the redirect just
  breaks the site for users.

A minimal Caddyfile that lets the provider's Caddy do its job:

```caddyfile
app.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		# SSE / streaming must not be buffered.
		flush_interval -1
	}
}
```

Verify issuance rather than assuming:

```bash
journalctl -u caddy --since '-2min' --no-pager | grep -iE 'certificate obtained|challenge failed'
echo | openssl s_client -connect app.example.com:443 -servername app.example.com 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

`issuer=... O=Let's Encrypt` is the pass condition. `Caddy Local Authority` means
`local_certs` is still set.

## 3. Bind the app to loopback, not 0.0.0.0

Once Caddy fronts it, the app should listen on `127.0.0.1:<port>` only. Exposing
`0.0.0.0:8080` adds nothing — that port is not forwarded anyway — and it invites
direct plaintext access if it ever is.

## 4. Verify from outside, with a real TLS client

Windows `curl`/schannel and some Git-Bash builds fail the handshake against
otherwise-fine sites and print `000`. That is a client problem, not a server one.
Confirm with a client that does proper TLS:

```bash
python -c "import urllib.request;r=urllib.request.urlopen('https://app.example.com/health',timeout=20);print(r.status,r.read()[:80])"
```

`000` from `curl` **plus** `200` from Python means the deployment is fine.

## 5. Environment gotchas seen on these hosts

- **`NODE_ENV=production` can break Elysia's route compiler.** With an
  unbundled, source-run service (`bun run src/main.ts`) Elysia takes an eager
  TypeBox branch and dies at the first schema-bearing route with
  `undefined is not an object (evaluating 'this.tb.buildResult.external')`.
  A/B-verified: `NODE_ENV=production` → boot fails; variable unset → serves 200.
  The bundled binary is unaffected because `scripts/binary/aot.ts` patches the
  `SchemaCompile(...)` call at build time.

  **Verified NOT to fix it:** calling `setupTypebox({ typebox: {...} })` before
  any route module. Tested on elysia 2.0.0-beta.16 + typebox 1.3.27 — the crash
  persisted. Do not reach for it as the cure. The state that works today is
  simply **leaving `NODE_ENV` unset**; check what actually depends on it before
  setting it (pino's pretty transport only attaches on a TTY anyway, so
  unsetting it costs little).
- **`ProtectHome=true` in a systemd unit blocks `/root/.bun/bin/bun`.** Install
  bun to `/usr/local/bin` (or set `ProtectHome=read-only`) or the unit fails
  with `status=203/EXEC`.
- **`su - postgres -c ...` prints the login MOTD and swallows your query
  output.** Use `runuser -u postgres -- psql -tAc "..."` instead. A `||`-chained
  "create role if absent" script silently no-ops this way; verify the role
  exists afterwards rather than trusting the script.
- **`bun upgrade` needs `unzip`**, which minimal Debian images lack. Install it,
  or use `curl -fsSL https://bun.sh/install | bash` and copy the binary out of
  `~/.bun/bin`.
- **A `PORT` duplicated in the env file** makes the last one win silently. After
  editing, `grep -c '^PORT='` and expect exactly `1`; confirm with
  `ss -lnt` rather than the config file.

## 6. Provisioning checklist (fresh NAT VPS)

```bash
apt-get update && apt-get install -y git curl unzip ca-certificates postgresql postgresql-contrib
runuser -u postgres -- psql -c "CREATE ROLE app LOGIN PASSWORD '<generated>'"
runuser -u postgres -- createdb -O app app
git clone --depth 1 --branch <tag> <repo> /opt/<app>
cd /opt/<app> && bun install --frozen-lockfile && bun run dashboard:build
# .env: 0600, secrets generated on the host, never copied from another deployment
# systemd unit: ExecStart=/usr/local/bin/bun run /opt/<app>/src/main.ts
# Caddyfile: reverse_proxy 127.0.0.1:<port> with flush_interval -1
```

Then prove it: `systemctl is-enabled` both units, outside probe on 443, and a
real TLS client returning 200 on `/health` and the console route.

## 7. Rotate anything you pasted into a chat

Secrets that reach a transcript must be treated as public. Generate fresh ones
on the host (`secrets.token_urlsafe`, `base64.b64encode(secrets.token_bytes(32))`)
and never reuse a value from a pasted env file — especially an encryption key,
which invalidates every stored credential when it changes.

## 8. Patch the source, not the installed tree

Hot-patching files directly on the server (e.g. copying a module into
`/opt/<app>/src/`) fixes the running process but is lost on the next clone or
redeploy. If a patch is load-bearing, it belongs in the repository as a commit;
otherwise record it as a known limitation rather than letting the server drift
from the tag it claims to run.

## 9. Cartethyia specifics

The gateway's shape on a host like this, verified end to end on Dahono Cloud:

**Environment** (`/opt/cartethyia/.env`, mode `0600`):

```dotenv
PORT=8080
DASHBOARD_DIST=/opt/cartethyia/dist/dashboard
CARTETHYIA_PUBLIC_ORIGIN=https://<domain>
# Caddy proxies over loopback, so only loopback may assert a client IP.
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://cartethyia:<generated>@127.0.0.1:5432/cartethyia
# One instance means in-process coordination is correct; `normal` requires Redis.
REDIS_MODE=disabled
CARTETHYIA_ENCRYPTION_KEY=<base64 of 32 random bytes>
CARTETHYIA_API_KEY=carte_<generated>
```

Do **not** set `NODE_ENV=production` on a source-run service — see §5. It is not
needed: the logger already emits JSON whenever stdout is not a TTY.

`CARTETHYIA_PUBLIC_ORIGIN` must carry the same scheme the browser uses. An
`http://` origin behind an HTTPS front door makes OAuth redirect URIs wrong.

**Unit** (`/etc/systemd/system/cartethyia.service`): `WorkingDirectory` +
`EnvironmentFile` pointing at the checkout, `ExecStart=/usr/local/bin/bun run
/opt/cartethyia/src/main.ts`, `After=postgresql.service`, and
`ReadWritePaths=/opt/cartethyia/data /opt/cartethyia/.env` under
`ProtectSystem=strict`. The gateway writes telemetry and payload capture under
`data/`; a read-only filesystem without that carve-out fails at first write.

**Build order matters.** `bun run dashboard:build` must run before the service
starts, because the gateway serves `dist/dashboard` from `DASHBOARD_DIST` and
there is no runtime fallback.

**Postgres**: create the role and database with `runuser -u postgres --`, not
`su - postgres -c` (§5). `CARTETHYIA_DB_MODE=full` reads `DATABASE_URL`, and the
migrations run at boot from `migrations/full-postgres/`.

**First boot** seeds the schema and logs
`CARTETHYIA_API_KEY is set but no console user exists yet; complete the
first-boot wizard at /console`. That is expected, not a failure: open `/console`
and finish the wizard, which then seeds the key.
