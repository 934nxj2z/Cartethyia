# Host and runtime gotchas

Verified on real hosts. Each of these cost time once; none should cost it twice.

## `NODE_ENV=production` once broke a source run — now guarded

A source run (`bun run src/main.ts`) used to die at boot with:

```
undefined is not an object (evaluating 'this.tb.buildResult.external')
```

The chain, confirmed by A/B on elysia 2.0.0-beta.16 + typebox 1.3.27:

1. `NODE_ENV=production` made `resolveElysiaPrecompile()` return true.
2. `precompile: true` sets `eager` on the route validator.
3. The eager branch calls TypeBox's `SchemaCompile(schema)` and reads
   `.buildResult.external`, which **does not exist** outside a bundler.

Only the built artifact can take that branch: `scripts/binary/aot.ts` rewrites
the call site and bundles the namespaces statically.

**`setupTypebox(...)` does not fix it.** It wires the namespaces but does not
stop the eager branch from reading the missing field — tested, crash persisted.
`src/boot/elysia-typebox-bridge.ts` still exists and is still needed, but it is
necessary and not sufficient.

**Current fix:** `resolveElysiaPrecompile()` returns false when
`CARTETHYIA_SOURCE_RUN=1`, so a source run never takes the eager branch. Set
that variable whenever you start from source with `NODE_ENV=production`.
[`scripts/install/vps.sh`](../references/install-script.md) sets it, and also
builds the AOT binary so production keeps its precompilation where it is safe.

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
