# Cartethyia documentation

New contributors and agents: start with the
[agent context](agent-context.md) for a verified architecture map and links to
the owning code, guides, and procedures.

Start here if you are installing or running Cartethyia:

- [Why Cartethyia](why-cartethyia.md) — the problem it was built for, what is
  different from plain forwarders, the custom-built capabilities shaped by
  operating this gateway, the Bun + Elysia choice, and the
  reverse-engineering method for provider gates. Start here if you want the
  reasoning rather than the mechanics.
- [Getting started](getting-started.md) — requirements, database mode, `bun setup`,
  encryption key, starting the stack, Docker, migrations, and verification.
- [Installation](installation.md) — VPS/systemd, reverse-proxy wiring, and
  the one-shot install script. Local, Docker, and mode choice are in
  [getting started](getting-started.md).

How the system is built — [reference/](reference/README.md), one page per layer:

- [Architecture](reference/architecture.md) — process, request path, routing
  snapshot, data.
- [Model name forms](reference/model-name-forms.md) — requested vs canonical vs
  routed vs displayed; why the effort suffix gains a space in Request Detail and
  why the combo prefix is stripped before dispatch.
- [Providers](reference/providers.md) — the provider layers, credentials,
  discovery, and what makes each family non-standard.
- [Codebase size](reference/codebase-size.md) — tracked backend and frontend
  source-line counts and counting scope.
- [Configuration](reference/configuration.md) — variables declared in
  `src/config/spec.ts` (not the separate database, setup, or Compose settings).
  **Generated** from `src/config/spec.ts`; regenerate, never edit by hand.
- [SQLite parity](reference/sqlite-parity.md) — measured dialect differences
  between Lite and Full.

One page per feature — [features/](features/README.md): what it is, the data
behind it, who owns it. CLI model mapping, share keys, network pools, routing
aliases and combos, Usage floor, and Buddy media generation.

## The split

The reference pages hold the **indexes** — route tables, snapshot mechanics, and
one summary per layer. They summarise one row and
link into `features/` for the narrative behind it. Do not grow them into feature
manuals; add a page under `features/` instead.

```text
documentation/
├── agent-context.md      repository onboarding and verified subsystem map
├── getting-started.md    installing and running it
├── installation.md       VPS/systemd, reverse proxy, one-shot script
├── why-cartethyia.md     the problem it was built for and how it differs
├── research/             live investigations, kept while they are open
├── assets/screenshots/   console screenshots the README showcases
├── reference/            how it is built, one page per layer
└── features/             one page per feature
```

Procedure and the layer maps live in `.skills/`, not here. Each skill owns one
topic: `cartethyia-engineering` (invariants, taste, gates, and the backend map),
`cartethyia-reverse-engineering` (tracing Cartethyia's internal behavior, and
static inspection of an external client), `cartethyia-trace-replay` (reproducing
a failing request, and
the protocol seam map), `cartethyia-schema-telemetry` (schema and migrations),
`cartethyia-health-routing` (account and model health),
`cartethyia-provider-catalog` (adding and authenticating a provider),
`cartethyia-console-api` (authoring a console domain, and the console surface
map), and `cartethyia-dashboard` (browser code, and the page map). `AGENTS.md`
routes you to the right one.

For the product overview, supported clients, and Cartethyia's main benefits, see
[`README.md`](../README.md).

For contribution rules and pull requests, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
