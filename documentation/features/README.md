# Features

One page per user-facing feature: what it is, the data that carries it, the
code that owns it, and where to change it.

These pages hold the *narrative*. The reference pages still hold the indexes —
route tables, snapshot mechanics, one summary per layer — and each of them points
here for the detail behind a row. When a feature grows enough to need a page,
give it one here and shrink the prose in `architecture.md` and the four
`.skills/.../references/*.md` layers (backend, protocol-and-translation,
console-api, dashboard-map) to a summary plus a link. Do not grow those into
feature manuals.

| Feature | What it does |
| --- | --- |
| [CLI model mapping](cli-model-mapping.md) | Reroute a CLI tool's native model slots (`opus`, …) to operator-chosen targets, per API key |
| [Share keys](share-keys.md) | Issue a public link that enrolls a child key under a parent's policy |
| [Network pools](network-pools.md) | Choose and meter the egress a request leaves through |
| [Routing aliases and combos](routing-aliases-combos.md) | Name a model something else, or fan a name out to several |
| [Usage floor](usage-floor.md) | Skip accounts whose remaining quota is at or below a provider threshold |
| [Buddy media generation](buddy-media-generation.md) | Generate images and submit/poll video tasks through Buddy providers |
| [Buddy CLI identity](buddy-cli-identity.md) | Present a Buddy provider as the official CLI client rather than the desktop app |
| [Cursor provider](cursor-provider.md) | Run Cursor's agent protocol across two client requests, and refuse anything the client did not declare |

Procedure does not live here. `.skills/` owns procedure, and each skill names
the layer's owner: [cartethyia-health-routing](../../.skills/cartethyia-health-routing/SKILL.md)
for pools and cooldowns, [cartethyia-console-api](../../.skills/cartethyia-console-api/SKILL.md)
for authoring a console domain, and
[cartethyia-dashboard](../../.skills/cartethyia-dashboard/SKILL.md) for
browser code. [AGENTS.md](../../AGENTS.md) routes you to the right one.
