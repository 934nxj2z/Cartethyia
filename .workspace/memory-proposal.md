# Memory proposal — for review, no action taken

Companion to [memory-inspection.md](memory-inspection.md). Nothing here has been
implemented; no production file was touched. Each item needs your confirmation
before it moves.

Ranked by **evidence strength × cost saved ÷ risk**. The honest summary: this
gateway is not leaking. Idle is ~132 MiB with a 512 MiB limit, and 600 requests
retained +0.5 MiB. What follows is about *bounds that are missing or wrong*, not
about a fire.

---

### P0 (new, and I would do this before anything else)

**The compiled binary admits 8 GiB request bodies while its own comment says 8 MiB.**

`scripts/binary/start.ts:12`:
```ts
process.env.CARTETHYIA_SERVER_MAX_BODY_BYTES ??= String(8 * 1024 * 1024 * 1024);
```
`src/main.ts:111` comments: *"8 MiB cap on request bodies keeps a rogue client
from allocating gigabytes of memory in the ingress path."*

1024× the stated intent, on the artifact that ships to operators. With
`PROCESS_CONCURRENCY_CAP = 64` and `full` capture mode holding the body twice,
the worst-case ingress hold is effectively unbounded.

- Change: align the binary default with the documented intent (8 MiB, or make it
  explicit and configurable), and fix the comment.
- Risk: **behaviour change for anyone relying on large uploads** through the
  binary. This is the one item here that could break a real install, which is
  exactly why it needs your confirmation rather than my judgement.

---


## Tier 1 — cheap, evidence is direct

### P1. Raise `MODEL_CATALOG_CACHE_MAX_ENTRIES` to clear the provider count

64 vs **73 bundled providers** (measured). The cache is permanently over cap, so
a rebuild evicts a provider it immediately needs again — pure churn, no saving.

- Change: `model-catalog-cache.ts:20` → `128` (or derive from the registry).
- Risk: near zero. The bound exists to stop *re-loads* accumulating; 128 entries
  of a 73-provider world is still a bound.
- Cost: removes churn; does not change steady-state RSS.

### P2. Bound `PackedCatalog.metadataCache`

Only cache in the codebase with no cap (`catalog-format.ts:195`), filled on every
`metadataAt()` hit. Worst case 8941 entries.

- Change: add an entry cap with the same oldest-first eviction the rest of the
  codebase uses, or reuse `TtlCache`.
- Risk: low — it is a pure memo of data already derivable from the packed blob.
- Decide: cap by entries (e.g. 2048) or by a byte estimate?

### P3. Export the cache gauges that do not exist

Only `cartethyia_quota_cache_entries` is visible. Model catalog, discovery,
version, and telemetry buffers are all invisible, so growth in them cannot be
detected without a heap dump.

- Change: add gauges for catalog cache size, telemetry buffer depth, and
  snapshot candidate count.
- Risk: none. This is what makes every item below measurable afterwards.
- **I would do this first** — it is how the next three get proven rather than
  argued.

---


## Tier 2 — real saving, needs a design decision

### P9. Give the non-streaming path the cap streaming already has

Streaming caps the client response at 512 KiB (`CLIENT_RESPONSE_CAP`);
non-streaming has no cap and holds four copies at once. Nothing on the request
says which path it takes, so today a buffered response is the unbounded one.

- Change: apply the same cap on the buffered path, or stream everything.
- Risk: a legitimate large non-streaming response would be truncated for
  telemetry purposes. Needs a decision on whether the cap applies to what is
  *returned* or only to what is *captured* — I would not guess.

### P10. Cap the capture request side, not just the response

`readBoundedBody` caps provider responses at 256 KiB but leaves request bodies
uncapped, and `firedCaptures[]` holds up to 8 of them per request.

- Change: apply `PROVIDER_CAPTURE_MAX_BYTES` to the request body too.
- Risk: low — captures are diagnostics, not the response itself.


---

### P4. Stop paying 26.9 MiB for `bundled-model-catalog` at boot

69% of the boot cost, and `modelsDevCatalog` (+5.2 MiB, measured) decompresses
eagerly at import whether or not pricing is ever needed.

Options, roughly ascending in effort:

| Option | Saving | Cost |
|---|---|---|
| Lazy-init `modelsDevCatalog` on first `resolve()` | ~5 MiB + 34 ms boot | small; touches `provider-model-definition.ts` |
| Don't retain the boot catalog Map; let it drop after seeding | up to ~3.5 MiB heap | needs checking that console/probing reads can rebuild on demand |
| Don't seed catalogs for providers with no account | largest, scales with providers | behaviour change — models would appear only once an account exists |

The third is the only one that scales, and it is also the only one that changes
what an operator sees. **Your call whether that tradeoff is acceptable** — I
would not pick it on your behalf.

### P5. Share the per-candidate pool maps in the route snapshot

`resolveNetworkPools()` allocates fresh `limits`/`weights` per candidate
(`route-catalog.ts:485`), across a fan-out of model × account. `capability_profile`
is already shared per model, so the pattern exists.

- Saving: scales with accounts — the one item that grows with operator data.
- Risk: must confirm nothing mutates those maps downstream. Needs a read of
  every consumer before changing.

### P6. Remove the dead `RouteSnapshot.created_at`

Stamped at `route-model.ts:456`, read nowhere. Not a memory item — listed
because it is adjacent and free.

---

## Tier 3 — correctness issues found on the way (not memory)

### P7. `usage-flush` eviction drops usage silently

At `FLUSH_PENDING_MAX_KEYS = 5000` the oldest key's delta is **deleted, not
flushed** (`usage-flush.ts:101`). That permanently undercounts
`lifetime_tokens_consumed`, and — unlike the telemetry buffer, which increments
`cartethyia_telemetry_dropped_total` — it is unmetered.

- Decide: meter it, or block instead of evict?
- This is a data-integrity bug that only appears past 5000 active keys in one
  window. Not urgent on this install; urgent on a busy one.

### P8. SQLite: two missing pragmas

- `journal_size_limit` absent → WAL has no disk cap; a long-lived reader pins it
  and it grows between checkpoints. (Disk, not RAM.)
- `hard_heap_limit` absent while `temp_store = MEMORY` → an unbounded
  `ORDER BY`/`GROUP BY` grows the heap with no ceiling.

Both are one-line additions in `applyFilePragmas`. Low likelihood, cheap
insurance.

---

## What I would not do

- **Touch the quota cache (1024, 15 min).** It is the largest bounded tier and
  it is behaving. Shrinking it trades upstream quota calls for RAM — a bad trade
  unless measurement says otherwise.
- **Add Redis to lite mode to save RAM.** It moves memory, it does not remove it,
  and it adds a failure mode.
- **Anything in Tier 2 before P3 ships.** Without gauges, a saving cannot be
  distinguished from allocator noise — the same problem that makes "+0.5 MiB"
  above inconclusive.

---

## Measurement still missing

None of the Tier 2 numbers are proven, because:

1. The dispatch path was never measured under load (only `/health`).
2. Lite mode only — Postgres adds a connection pool.
3. No multi-tenant data, so fan-out and quota cardinality are at their floor.

P3 exists to close (1) and (3). **If you want Tier 2 to be decided by data
rather than by my judgement, approve P3 first and I will re-run the probes
against a loaded gateway.**
