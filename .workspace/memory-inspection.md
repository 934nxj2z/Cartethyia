# Memory inspection — findings

**Status: inspection only. No production code changed.** Every number below was
measured or read from source on 2026-10-19 against `v2.4.6` (Bun 1.4.2, lite
mode, Redis on).

Measured by: `.workspace/memory-probe.ts` (module graphs), `.workspace/memory-load.ts`
(traffic), and `/metrics` on a running gateway.

---

## 1. Where the memory goes

### Boot, from the gateway's own startup trace

| Phase | RSS delta |
|---|---|
| entrypoint ready | 104.4 MiB (baseline incl. Bun runtime) |
| database-connect | +1.1 |
| database-migrations | +0.2 |
| provider-seed | +0.9 |
| retired-provider-cleanup | +0.2 |
| byok-registration | +0.1 |
| **bundled-model-catalog** | **+26.9** |
| bundled-model-seed | +9.1 |
| static-token-reconciliation | +0.1 |
| **listener-ready** | **148.2 MiB** |

**`bundled-model-catalog` is 69% of the whole boot cost.** Everything else is
rounding.

### Steady state (idle, no traffic)

```
cartethyia_memory_rss_bytes        132.3 MiB
cartethyia_memory_heap_used_bytes   19.6 MiB
cartethyia_memory_heap_total_bytes  24.1 MiB
cartethyia_memory_limit_bytes      512.0 MiB
```

So: **~132 MiB RSS at idle**, of which Bun itself is ~33 MiB (measured on a bare
`bun` process before any repo import). Heap is only 19.6 MiB — most of the RSS
is runtime, code, and external buffers, not JS objects.

### Under traffic

600 requests at concurrency 16 → **+0.5 MiB heap retained** after settling.
Health is within allocator noise. The dispatch path was **not** measured (see
gap 4 below).

---

## 2. The retained floor — what is held for the process lifetime

### 2.1 The offline model catalog is decompressed eagerly at import

`src/providers/discovery/models-dev-catalog.ts:145`

```ts
const CATALOG_BYTES = brotliDecompressSync(Buffer.from(CATALOG_BLOB_BROTLI_BASE64, "base64"));
```

- `src/providers/provider-model-definition.ts:12` imports it **statically**, so
  it decompresses on module load — before `buildProductionDeps()` runs.
- Measured: **+5.2 MiB RSS, 34 ms**, on importing that one module.
- Source is 140.1 KB of base64 → 583 KB packed (`CATALOG_BLOB_BYTES = 597744`);
  `PackedCatalog` then copies into a 4-byte-aligned buffer.
- 8941 rows, 232 providers.

This is not a leak — it is a deliberate offline catalog. But it is paid on every
boot whether or not any request needs pricing, and it cannot be opted out of.

### 2.2 The bundled catalog Map outlives its own cache bound

`MODEL_CATALOG_CACHE_MAX_ENTRIES = 64` (`model-catalog-cache.ts:20`) bounds the
per-provider *promise* cache — but **there are 73 bundled providers** (measured:
`bundledModelCatalog()` returns 73 entries, 635 model rows, 3.5 MiB heap).

Consequence: the cache is permanently over its cap, so a rebuild evicts a
provider it is about to need again. Worse, eviction does **not** free the boot
catalog: `ProductionDeps.bundledModelCatalog` (`dependencies.ts:534`) holds its
own direct references, reachable from the console router and the probing
service for the whole process. The bound prevents re-loads from piling up; it
does not release what boot already built.

### 2.3 `PackedCatalog.metadataCache` has no bound

`src/providers/discovery/catalog/catalog-format.ts:195`

```ts
private readonly metadataCache = new Map<number, ModelsDevModelMetadata>();
```

Filled on every `metadataAt()` hit (`:402`), never evicted, no cap. Worst case
8941 entries. Every other cache in this codebase has a constant; this one does
not. It is the clearest asymmetry found.

### 2.4 Route snapshot: global, and candidates are a fan-out

- **One snapshot for all tenants** — `loadRouteCatalogSnapshot(undefined)` at
  `route-catalog.ts:735`. Tenancy lives *inside* it.
- Candidates ≈ **model rows × non-disabled accounts** per provider. With 73
  providers seeded whether or not they have an account, and every account
  multiplying it, this is the structure that scales with operator data rather
  than with code.
- `resolveNetworkPools()` (`route-catalog.ts:485-486`) allocates **fresh**
  `limits` and `weights` objects per candidate — not shared across the
  account fan-out. `capability_profile` *is* shared per model (the one real
  dedup).
- Max 2 snapshots live (1 cached + 1 in-flight); eviction is explicit
  `invalidate()` only, no TTL, no size cap.
- `RouteSnapshot.created_at` is stamped (`route-model.ts:456`) and **read
  nowhere** — a dead field.

### 2.5 Quota cache is the largest bounded in-process tier

`src/console/quota/cache.ts:47-48` — `ttlMs: 900_000` (15 min), `maxEntries: 1024`,
keyed `quota:v5:{lens}:{accountId}` where lens is tenant or `global`. So
cardinality is **accounts × up to 2 lenses**, and each entry holds a whole
usage-`windows[]` array. 1024 such entries is the biggest allocation with a
constant attached to it. On a memory-only deployment (no Redis) this *is* the
cache, not a shadow of one.

### 2.6 Per-request retention: the streaming/buffered asymmetry

The clearest gap in the whole inspection, because the two paths disagree about
the same data:

| Path | Cap on the client response | Source |
|---|---|---|
| Streaming | **512 KiB** (`CLIENT_RESPONSE_CAP`); transcript also 512 KiB, split head/tail with index-pointer eviction and no `shift()` memmove | `dispatch/streaming/encoder.ts:26-29` |
| Non-streaming | **none** | `dispatch/proxy-request.ts:252` |

Non-streaming dispatch accumulates `events: CanonicalEvent[]` with no bound, then
holds **four copies at once**: the `events` array, `output.bytes` (encoded wire),
`decodedClientText` (a `TextDecoder` decode of the whole thing), and
`parseCapturedBody(decodedClientText)` (a parsed third copy), plus
`state.clientResponseText`. A streamed response is bounded; a buffered one is not —
and nothing about the request says which path it will take.

Two more per-request accumulations, both released only at completion:

- **`ingressBody` in `full` capture mode** (`guards/request-context.ts:241`) is
  released only when `keepsIngressBody()` is false. In `full` mode it stays for
  the entire upstream stream, held *alongside* `canonicalRequest` — a second
  materialization — so roughly 2× the request body for the stream's duration
  (stall budget 360 s + 120 s upstream timeout).
- **`firedCaptures[]`** (`attempt-loop.ts:160,347`) retains each attempt's full
  translated provider request body. `readBoundedBody` caps the *response* at
  256 KiB (`PROVIDER_CAPTURE_MAX_BYTES`) but the *request* side has no cap, so
  up to 8 request bodies (max attempts) are held concurrently.

### The body-size ceiling is not one number

`CARTETHYIA_SERVER_MAX_BODY_BYTES` has three effective values:

1. Spec default **4 MiB** (`config/spec.ts:90-98`), with `max: Number.MAX_SAFE_INTEGER`.
2. Wired into `resolveMaxBodyBytes()` at `main.ts:44` and `main.ts:112`.
3. **`scripts/binary/start.ts:12` sets it to 8 GiB** for the compiled binary.

`main.ts:111` still comments "8 MiB cap on request bodies keeps a rogue client
from allocating gigabytes of memory in the ingress path" — while the shipped
standalone binary admits **8 GiB**, 1024× the stated intent. Combined with
`PROCESS_CONCURRENCY_CAP = 64` and the `full`-mode double hold above, the
worst-case ingress hold is not 256 MiB but effectively unbounded.

This is a comment/behavior contradiction I verified by reading both files
directly, not a subagent inference.

---

## 3. Bounded vs unbounded — the summary

| Holder | Bound | Verdict |
|---|---|---|
| Quota cache | 1024, 15 min | Bounded; biggest bounded tier |
| Model catalog cache | 64 | Bounded, **but 73 providers** → permanent thrash |
| Discovery cache | 256, 10 min | Bounded; 2 keys in practice |
| Provider version cache | 256, 30 min | Bounded; 21 static keys |
| Telemetry batch buffer | 10000 items / 10 MiB | Bounded **and** metered (`cartethyia_telemetry_dropped_total`) |
| Usage flush pending | 5000 keys, 1 s | Bounded, **but eviction drops usage silently** |
| Route snapshot | none (2 live) | Grows with operator data |
| `modelsDevCatalog` | n/a | Eager, permanent, 5.2 MiB |
| Boot catalog Map | none | Permanent; cache bound does not release it |
| **`metadataCache`** | **none** | **Unbounded, unmetered** |
| SQLite temp store | none | `temp_store = MEMORY`, no `hard_heap_limit` |

---

## 4. SQLite

`applyFilePragmas` (`db-sqlite.ts:422-429`) is the whole set:

```
journal_mode = WAL      synchronous = NORMAL     busy_timeout = 5000
cache_size   = -8192    (8 MiB)
temp_store   = MEMORY   wal_autocheckpoint = 1000
```

- **8 MiB page cache** — a hard working-set ceiling, since `mmap_size` is never
  set (default 0).
- **`journal_size_limit` absent** — the WAL has no on-disk cap. A long-lived
  reader pins it and it grows between successful checkpoints. This is disk, not
  RAM, but it is the one genuine unbounded growth in the pragma set.
- **`hard_heap_limit` absent** while `temp_store = MEMORY` — an unbounded
  `ORDER BY`/`GROUP BY` grows the heap with no ceiling. Low likelihood, no
  mitigation.
- Write amplification is otherwise sound: both hot writers coalesce,
  `NORMAL` removes the per-commit fsync.

---

## 5. Gaps in this inspection

Stated plainly, because they bound what the numbers mean:

1. **The dispatch path was not measured under load.** Only `/health`. Snapshot
   candidates, quota entries, and streams live on the real route.
2. **Postgres path not measured** — everything above is lite mode. Full mode
   adds a connection pool with its own per-connection buffers.
3. **No multi-tenant data.** Snapshot fan-out and quota cardinality both scale
   with accounts and tenants; this box has almost none, so the numbers are a
   floor, not a ceiling.
4. **Only one cache gauge is exported** (`cartethyia_quota_cache_entries`).
   Every other cache is invisible from `/metrics`, so growth in them is
   undetectable without a heap dump.
5. `metadataCache` is private, so its size could not be read at runtime — the
   unbounded claim is from source, not measurement.

---

## 6. What looks worth doing

Ranked by (evidence strength × cost saved), and kept separate from the findings
above so the two can be disagreed with independently: see
[memory-proposal.md](memory-proposal.md).
