# Probing an egress — blocked, allowed, throttled, unreachable

> [!IMPORTANT]
> **A reachable proxy is not an allowed egress.** OpenCode answers
> `GET /inference/v1/models` with `200` from an address it refuses on the
> dispatch route (verified live). Any check that only proves the tunnel opens
> will call a blocked proxy healthy.

**Date:** 2026-10-17. **Tool:** `scripts/operations/probe-egress.ts`.
**Contract:** [`.skills/cartethyia-trace-replay/references/opencode-free-tier.md`](../../.skills/cartethyia-trace-replay/references/opencode-free-tier.md).

## The question the probe answers

Not "is this proxy up" — "will this provider serve a dispatch from this
address". Those come apart in exactly the case the probe exists for: a flagged
egress carries traffic fine and is refused only on the dispatch lane.

So the probe sends the provider's **own dispatch**: the adapter's headers, the
full agent tool set, `stream: true`, through the same `createValidatedFetch` +
pool agent the gateway uses. A hand-built stand-in can pass while dispatch
fails, which is the failure this avoids.

## Verdicts

| Verdict | Evidence | Meaning | Fix |
| --- | --- | --- | --- |
| `allowed` | `2xx` | The upstream served the dispatch. | — |
| `allowed` | any `4xx` that is **not** the IP gate | The address was accepted and the upstream reached its own validation. | — |
| `throttled` | `429` | The address is accepted; the rate is spent. | Wait, or spread load. |
| `blocked` | `403` + `FreeTierError` | The upstream retired this address. | Replace the proxy. Waiting does nothing. |
| `unreachable` | CONNECT/DNS failure, timeout, `5xx`, `407` | The probe never got a usable answer. | Says nothing about the address. |

### The `4xx` rule is the load-bearing one

The IP gate runs **before** the body is validated. So a `400 messages must not
be empty` proves the egress was accepted — it is a broken probe body, not a
broken proxy.

This was learned the hard way. The probe used to send `messages: []` and map
every non-2xx, non-403 answer to `unreachable`. Four proxies that answer `200`
to a real dispatch were therefore reported as `OpenCode unreachable` — the UI
blamed the pools for the probe's own defect, and an operator reading it would
have discarded the only egresses that worked.

Both halves are fixed: the probe sends one short user turn, and a `4xx` from the
upstream's own validation reads as `allowed`.

## Usage

```bash
# One machine egress and two proxies, side by side.
bun run scripts/operations/probe-egress.ts -p opencode --direct \
  --proxy nozomi.proxy.rlwy.net:48011 \
  --proxy iriguchi.proxy.rlwy.net:23244

# From a file, one endpoint per line ('#' comments allowed).
bun run scripts/operations/probe-egress.ts -p opencode -f proxies.txt

# Piped in.
cat proxies.txt | bun run scripts/operations/probe-egress.ts -p opencode --stdin

# Machine-readable, one object per line.
bun run scripts/operations/probe-egress.ts -p opencode -f proxies.txt --json
```

| Option | Effect |
| --- | --- |
| `-p, --provider <id>` | Required. Must be IP-scoped; `opencode` is the only one. |
| `--direct` | Also probe this machine's own egress. |
| `--proxy <endpoint>` | Repeatable. Bare `host:port` is read as `http://`. |
| `-f, --file <path>` | Read endpoints from a file. |
| `--stdin` | Read endpoints from stdin. |
| `--concurrency <n>` | Parallel probes, default 4. |
| `--timeout <ms>` | Per-probe timeout, default 30 s. |
| `--json` | One JSON object per line. |
| `-h, --help` | Usage. |

A bare positional argument is an endpoint too, so
`... -p opencode host:port` works without a flag. Accepted schemes: `http://`,
`https://`, `socks5://`, or bare `host:port`.

**Exit code:** `0` when at least one egress is `allowed` or `throttled`, `1`
otherwise — so it can gate a shell pipeline.

## Sample run

```
Probing opencode via https://opencode.ai/inference/v1/chat/completions
6 egress(es), 4 at a time

direct                         BLOCK  403      846ms  upstream refused this egress
nozomi.proxy.rlwy.net:48011    OK     200     4928ms
iriguchi.proxy.rlwy.net:23244  OK     200     2237ms
mainline.proxy.rlwy.net:49684  OK     200     3531ms
junction.proxy.rlwy.net:41103  OK     200     5773ms
iriguchi.proxy.rlwy.net:15117  BLOCK  403      781ms  upstream refused this egress

allowed 4 · blocked 2 · throttled 0 · unreachable 0
```

Note `direct` is blocked while four proxies are allowed: the refusal follows the
**address**, not the machine, the client, or the request.

## Reading a result

- **`allowed` on one egress and `blocked` on another, same machine** — the
  refusal is the address. Use the allowed one.
- **`unreachable` everywhere** — the probes never ran. Check the endpoint
  format and the network before concluding anything about the provider.
- **`blocked` everywhere** — every egress tried is retired upstream. That is
  the `proxy_pool_blocked` / "all saturated" case in dispatch; add a proxy or
  replace one.
- **`throttled`** — the address works. It is a rate, not a refusal; it recovers.

## Pitfalls

- **Do not use `curl -x` to judge this.** In this environment `curl` fails the
  CONNECT tunnel with `error 43` while Bun's `fetch` succeeds through the same
  proxy. Use the script.
- **A proxy that refuses CONNECT is not blocked.** `ProxyConnectHandshakeError`
  is `unreachable`; it says the tunnel never opened. Some proxies refuse CONNECT
  to particular targets while serving others.
- **Do not judge from the model listing.** `GET /inference/v1/models` answers
  `200` from a blocked address.
- **Do not add a real prompt to the probe.** One short turn is enough; the gate
  reads the tool set and headers, not the content.

## Relationship to dispatch

The probe is **read-only**: it reports, and leaves pools in rotation. A real
dispatch that is refused is what retires an egress
(`flagPoolBlocked` → `proxy_pool_blocked`). Keeping "test" non-mutating is what
makes it safe to press.

## The dashboard tester, and three ways it lied

The Proxy Pool card's "Test OpenCode" runs the same probe. Three defects made
its verdict wrong even when the probe itself was correct.

### 1. A stale verdict survived an edit

Verdicts were keyed by **pool id**. Re-point a pool from a blocked proxy to a
working one and the card still read `OpenCode blocked`, because nothing
compared the verdict to the address it was measured on.

A verdict is a statement about one egress, so it now travels with that egress
(`dashboard/src/features/proxy/probe-freshness.ts`). An edited endpoint
discards it; a verdict recorded before the endpoint was known is kept.

### 2. The edit form tested the *saved* proxy, not the one being typed

`runAdhocTest` called `healthCheck(pool.id)`, which dials the stored endpoint.
An operator pasting a new proxy and pressing Test was told about the old one —
and the answer looked authoritative.

It now probes the endpoint **in the form** through the ad-hoc provider probe,
so the verdict describes what is about to be saved. The one exception is an
unchanged endpoint on a credentialed pool: the ad-hoc form never carries a
credential (the console never sends a secret back to the browser), so that case
keeps the health check.

### 3. A 20 s timeout was too tight under the batch's own concurrency

Measured through live proxies on 2026-10-17:

| Situation | Healthy dispatch |
| --- | --- |
| One probe, alone | 2–6 s |
| Four probes together (the UI's concurrency) | **16.7 s** |

At 20 s that left ~3 s of margin, so a working egress intermittently reported
`Probe timed out` → `unreachable`. The timeout is now 45 s. It is not a quality
threshold: a probe that needs that long is slow, and the reported latency is
what says so.

## The lesson that generalises

All three defects share one shape: **the tester answered a question nobody
asked.** Not "is this proxy up" but "will this provider serve this address" —
and each bug substituted a different, easier question (is the *stored* pool up,
is *some* address blocked, did it finish in 20 s) while presenting the answer
as the hard one.
