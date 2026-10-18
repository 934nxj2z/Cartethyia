# Agent context

This is the repository orientation page for a new contributor or coding agent.
It maps the verified architecture and the right sources to consult; it is not a
replacement for the subsystem procedures in `.skills/`.

## Start here

1. Read [AGENTS.md](../AGENTS.md) for repository rules and task-specific skill
   routing.
2. Use this page to locate the owner of the behavior being changed.
3. Read the linked feature/reference page and the closest skill before changing
   a subsystem with specialized invariants.
4. Check the current worktree and current source before relying on prior
   session summaries, examples, measurements, or this page's implementation
   details.

Source code and tests are the authority for current behavior. Documentation is
an explanation of that behavior and can lag; when they disagree, verify the
implementation and correct the owning documentation page.

## System shape

- `src/main.ts` starts one Bun/Elysia backend process. `src/boot/` composes the
  database, provider registry, route snapshot, console, gateway, workers, and
  observability.
- `dashboard/src/` is the browser-only React application. It calls
  `/console/api`; it must not import backend runtime modules, secrets, or
  database drivers.
- Requests are normalized into the canonical protocol model, planned against a
  route snapshot, filtered for account eligibility, then dispatched through a
  provider adapter. Admission leases are acquired separately from eligibility.
- Lite uses embedded SQLite; Full uses external PostgreSQL. `REDIS_URL` is
  optional and enables shared coordination/cache where supported. The selected
  database mode is explicit; setup details are in
  [getting started](getting-started.md).
- The PostgreSQL baseline is canonical. SQLite DDL is generated from it, and
  both backends carry the same numbered forward migrations under
  `migrations/full-postgres/` and `migrations/lite-sqlite3/`; older
  installations with retired migration history are recovered through
  backup/restore.

## Confirmed behavior worth knowing

- **Usage floor is live routing policy.** The provider-detail UI stores a
  per-provider threshold, evaluated per account before dispatch. Accounts at or
  below the threshold are skipped so routing can continue to another account.
  Missing quota readings are unknown, not proof that the floor was crossed;
  exhausted quota windows are still excluded. See
  [Usage floor](features/usage-floor.md).
- **Quota cache freshness is explicit.** Cache entries distinguish the last
  attempt from the last successful reading. A refresh failure retains a
  successful reading for up to 30 minutes; the dashboard exposes refresh state.
  The in-process cache is bounded and Redis is optional. The quota worker
  refreshes stale entries. Verify the current constants in
  `src/console/quota/cache.ts` and `src/workers/quota-refresh-sweep.ts` before
  relying on timing details.
- **Startup has phase-level tracing.** `buildProductionDeps()` logs named
  startup phases with elapsed time and RSS/heap observations. These logs help
  attribute startup cost; they are not a promise that every phase is lazy or
  that memory use is below a particular threshold.
- **BYOK and bundled providers are different paths.** BYOK rows use the generic
  OpenAI-compatible adapter and derive their wire contract from
  `resolveByokWireProfile`. Bundled providers can have dedicated adapters and
  authentication. DeepSeek is bundled and currently uses its Messages adapter
  for dispatch while retaining OpenAI-compatible model discovery.

## Where to work

| Concern | Owner | Start with |
| --- | --- | --- |
| Request parsing, protocol translation, streaming, errors | `src/protocol/`, `src/transport/`, `src/providers/` | [Protocol and translation](../.skills/cartethyia-trace-replay/references/protocol-and-translation.md), trace-replay skill |
| Candidate matching, eligibility, cooldowns, failover | `src/transport/routing/` | [Architecture](reference/architecture.md), [health-routing skill](../.skills/cartethyia-health-routing/SKILL.md) |
| Quota reads, cache, Usage floor, quota UI | `src/console/quota/`, `src/providers/quota/`, `src/workers/quota-refresh-sweep.ts`, provider-detail dashboard | [Usage floor](features/usage-floor.md), [Providers](reference/providers.md) |
| Provider catalog, auth, discovery, adapters | `src/providers/` | [Providers](reference/providers.md), provider-catalog skill |
| Egress, proxy pools, SSRF | `src/network/`, `src/console/routing/pools/` | [Network pools](features/network-pools.md), health-routing skill |
| Console API | `src/console/<domain>/` | [Console API](../.skills/cartethyia-console-api/references/console-api.md), console-api skill |
| Browser UI | `dashboard/src/` | [Dashboard](../.skills/cartethyia-dashboard/references/dashboard-map.md), dashboard skill |
| Schema or persistence behavior | `src/persistence/`, `migrations/`, `scripts/generate/` | [SQLite parity](reference/sqlite-parity.md), schema-telemetry skill |
| Startup, lifecycle, scheduled work | `src/boot/`, `src/workers/` | [Backend](../.skills/cartethyia-engineering/references/backend.md) |
| Environment variables | `src/config/spec.ts` | [Generated configuration reference](reference/configuration.md); regenerate, do not hand-edit |

## Verification and working state

Use the narrowest relevant command from the current `package.json`, for example
`bun run typecheck`, `bun run dashboard:typecheck`, a focused test through
`bun run test -- <selector>`, or the corresponding build. Confirm the exact test
runner syntax before using a selector. Documentation-only edits generally need
no build; inspect the diff, check local links, and run `git diff --check`.

Before editing, inspect `git status --short`. Preserve unrelated user changes,
do not stage or commit them, and do not infer that a prior session's files or
checks are still present. Do not commit unless the user asks.
