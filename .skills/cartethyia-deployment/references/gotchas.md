# Host and runtime gotchas

Verified on real hosts. Each of these cost time once; none should cost it twice.

## `NODE_ENV=production` breaks Elysia's route compiler

With an unbundled, source-run service (`bun run src/main.ts`) Elysia takes an
eager TypeBox branch and dies at the first schema-bearing route with:

```
undefined is not an object (evaluating 'this.tb.buildResult.external')
```

A/B-verified: `NODE_ENV=production` → boot fails; variable unset → serves 200.
The bundled binary is unaffected because `scripts/binary/aot.ts` patches the
`SchemaCompile(...)` call at build time.

**Verified NOT to fix it:** calling `setupTypebox({ typebox: {...} })` before any
route module. Tested on elysia 2.0.0-beta.16 + typebox 1.3.27 — the crash
persisted. Do not reach for it as the cure.

What works today is simply **leaving `NODE_ENV` unset**. Check what actually
depends on it before setting it: pino's pretty transport only attaches on a TTY
anyway, so unsetting costs little.

## `ProtectHome=true` blocks `/root/.bun/bin/bun`

The unit fails with `status=203/EXEC`. Install bun to `/usr/local/bin`, or set
`ProtectHome=read-only`. The unit in
[`shared-provisioning.md`](shared-provisioning.md) uses `ProtectHome=true`, so
`/usr/local/bin` is required.

## `su - postgres -c` swallows output

It prints the login MOTD and your query result disappears. Use:

```bash
runuser -u postgres -- psql -tAc "..."
```

A `||`-chained "create role if absent" script silently no-ops this way. Verify
the role exists afterwards rather than trusting the script.

## `bun upgrade` needs `unzip`

Minimal Debian/Ubuntu images lack it. Install it, or use
`curl -fsSL https://bun.sh/install | bash` and copy the binary out of
`~/.bun/bin`.

## Duplicated `PORT` in the env file

The last one wins, silently. After editing, `grep -c '^PORT='` and expect
exactly `1`. Confirm with `ss -lnt` rather than the config file.

## Poisoned resolver

Not a runtime bug but reads like one. See
[`egress-and-dns.md`](egress-and-dns.md) — this is the one to check before
debugging any upstream 4xx.

## Pulling the wrong remote

A checkout cloned from upstream may have its `origin` pointing somewhere that
does not carry your latest commits, so `git pull --ff-only` answers
`Already up to date` while the deployed code is stale. Check `git remote -v`,
and pull the explicit URL and branch if needed:

```bash
git pull --ff-only https://<host>/<repo>.git main
```

Then confirm with `git log --oneline -1` that the commit is the one you expect.

## Providers that cannot be enrolled automatically

Some providers expose `oauthFlows.import: false`, so a stored token cannot be
enrolled — only a browser device flow. See
[`verification.md`](verification.md).
