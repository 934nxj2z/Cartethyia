# Reference — how Cartethyia is built

One page per layer. These are the **indexes**: route tables, snapshot mechanics,
and one summary per layer. Each summarises one row and
links into [`../features/`](../features/README.md) for the narrative behind it.
Keep it that way — a feature that needs prose gets a page under `features/`.

| Page | Covers |
| --- | --- |
| [Architecture](architecture.md) | Process, request path, routing snapshot and its invalidation, data, what is intentionally absent |
| [Providers](providers.md) | Provider layers, boot and bundled vs BYOK, credentials and auth, discovery, quota, per-family notes |
| [Codebase size](codebase-size.md) | Tracked backend and frontend source-line counts and counting scope |
| [Configuration](configuration.md) | Every environment variable. **Generated** from `src/config/spec.ts` by `scripts/generate/config-reference.ts`; regenerate it, never edit it by hand |
| [Model name forms](model-name-forms.md) | Every spelling a model name takes and where each is resolved |
| [SQLite parity](sqlite-parity.md) | Measured dialect differences between Lite and Full, and which ones are not defects |

The backend, protocol, console, and dashboard maps moved into the skill that
owns the change, so the procedure and the map stay in one place:

- Backend — `.skills/cartethyia-engineering/references/backend.md`
- Protocol and translation — `.skills/cartethyia-trace-replay/references/protocol-and-translation.md`
- Console API — `.skills/cartethyia-console-api/references/console-api.md`
- Dashboard — `.skills/cartethyia-dashboard/references/dashboard-map.md`

Ownership boundaries live in [Architecture → Ownership](architecture.md#ownership).

Procedure is not here. `.skills/` owns it — `cartethyia-schema-telemetry` for a
schema or migration change, `cartethyia-health-routing` for cooldowns and
retries, `cartethyia-provider-catalog` for adding a provider,
`cartethyia-console-api` for a console domain, `cartethyia-dashboard` for
browser code.
