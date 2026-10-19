# OpenCode free tier: Cartethyia vs `opencode2api`

Comparison of this repo's OpenCode free-tier adapter against
`D:/MyGitRepository/Projects/HoneyC/ProxyRouter-Project/Public/opencode2api`
(a Go gateway by `jasonxu114514`).

**No code was changed.** This is a read-only comparison. Every claim below is
either quoted from source with `file:line` or measured locally.

Measured 2026-10-19. Two repos, two languages, same upstream gate.

---

## 0. The one thing that matters

`opencode2api` does not impersonate OpenCode with headers. It impersonates
**Bun** — because the official OpenCode clients *are* Bun programs, and the
free-tier gate fingerprints the TLS ClientHello, not just the HTTP headers.

It pulls in `github.com/refraction-networking/utls` (`go.mod`) and hand-builds
a ClientHello captured from Bun's BoringSSL:

> `internal/httpx/bun_dial.go:28` — "captured from Bun 1.4.3. Bun links its own
> BoringSSL, so the hello is the same on every platform: **JA4 `t13d1713h1`**,
> no GREASE, no padding, `http/1.1` as the only ALPN protocol and
> `X25519MLKEM768` as the first key share."

And it routes only free traffic through that client:

> `internal/gateway/upstream.go:436-441` — "Free-model traffic to the `/zen`
> and `/inference` lanes goes through the Bun client … every other request,
> including the Go tier (`/zen/go`), keeps the regular client."

**We run on Bun — so we already send that exact ClientHello.** I measured it
rather than assuming it:

| | Our `node:https` | Our `fetch()` (Bun) | Reference target |
|---|---|---|---|
| Cipher count | **52** | **17** | 17 |
| Ciphers | `1302-1303-1301-c02f-…` (OpenSSL order) | `1301-1302-1303-c02b-c02f-c02c-c030-cca9-cca8-c009-c013-c00a-c014-009c-009d-002f-0035` | identical |
| Extensions | 12 | **13** | 13 |
| Ext order | `65281-0-11-10-35-16-22-23-13-43-45-51` | `0-23-65281-10-11-35-16-5-13-18-51-45-43` | identical |
| Curves | `4588-29-23-30-24-25-256-257` | `4588-29-23-24` | `4588-29-23-24` |
| ALPN | `http/1.1` | `http/1.1` | `http/1.1` |
| JA3 md5 | `240e0d80b28284427fe5d392be811102` | `32301e23cb6fb17a4529be014c9231b2` | — |

Bun's own fetch matches the reference spec **exactly** — 17 ciphers in the same
order, the same 13 extensions in the same order, `X25519MLKEM768` first, one
ALPN protocol. (The 13th extension is SNI, absent from my first probe only
because it connected to a bare IP; with `serverName` set it appears and the
count matches.)

**But our outbound path does not use it.** `src/network/outbound-fetch.ts:3-4`
imports `node:http` / `node:https`, so our free-tier dispatch leaves with
OpenSSL's 52-cipher hello — the one fingerprint we cannot fix by adding a
header, and the one the reference gateway judged worth an entire hand-written
transport to get right.

That is the finding. Everything else below is smaller.

---

## 1. Where we agree (and I checked, rather than assumed)

| Thing | Ours | Reference | Verdict |
|---|---|---|---|
| Anonymous credential | `Bearer public` (`provider.ts` `ANONYMOUS_ZEN_BEARER`) | `Bearer public` (`gateway.go:41`) | **Same** |
| Credential is case-sensitive | — | yes, "Bearer PUBLIC" 401s (`upstream.go:1244`) | Same gate |
| `x-opencode-client` | `cli` | `cli` | **Same** |
| Session shape | `ses_` + 12 hex + 14 base62 | `ses_` + 12 hex + 14 base62 (`identity/request.go:201`) | **Same** |
| Counter window | 1–63, else 403 | 1–63, low 12 bits `0xFC0–0xFFF` | **Same** |
| `x-opencode-project` | bare 40-hex | v2: bare 40-hex (`upstream.go:1289`) | **Same** |
| Tool definitions must be genuine | yes, byte-exact (`tool-definitions.ts`) | yes, byte-exact (`opencode_tools.json`, embedded) | **Same** |
| Force `stream: true` | yes | yes | **Same** |
| No `x-opencode-request` on v2 | **absent** | v2 rejects it, 403 (`upstream.go:1290`) | **Same** |

The `x-opencode-request` point deserves a note, because it looks like a
contradiction and is not. The reference **does** send it — on the **v1 lane**
(`upstream.go:1271`). On the v2 `/inference` lane it is forbidden. We deleted
ours after measuring 2026-10-14 that adding it caused 403. We dispatch only on
`/inference/v1` (`provider.ts:33`) and never touch `/zen` (v1) — verified:
`grep '"https://opencode.ai/zen"' src/` returns nothing. **Both are right,
for different lanes.** Our deletion is correct for ours.

---

## 2. Differences

### 2.1 TLS — the real gap

| | Ours | Reference |
|---|---|---|
| Free-tier TLS | OpenSSL via `node:https` (52 ciphers) | uTLS replaying Bun's hello (17 ciphers) |
| HTTP version | whatever Node negotiates | HTTP/1.1 forced; `TLSNextProto` emptied, `NextProtos: ["http/1.1"]` (`pool.go:283-296`) |
| Header order | Node canonicalizes | `bunCommonHeaders` first in fixed order, then lowercased + sorted (`bun.go:483-505`) |

Worth knowing: the reference's own two layers **disagree**. Its TLS hello claims
Bun **1.4.3** (`bun_dial.go:28`) while its HTTP `User-Agent` claims Bun
**1.3.14** (`client.go:15`). If upstream ever cross-checks, those conflict.
We would not inherit that — Bun emits both consistently.

### 2.2 `Accept` on a free dispatch

- Ours: `accept: text/event-stream` (`provider.ts:128`)
- Reference: `Accept: application/json, text/event-stream` (`upstream.go:1293`)

The gate accepts ours today. The reference's value is what OpenCode 2.x's AI SDK
sends. This is the cheapest change on the list and the most likely to matter if
the gate tightens.

### 2.3 Tool fingerprint size

- Ours: **13** tools — `shell, glob, read, grep, webfetch, websearch, write, edit, subagent, execute, patch, question, skill`
- Reference: **12** embedded definitions; **`v2CoreTools` = 5** enforced — `shell, edit, glob, grep, read` (`upstream.go:475`)

We inject 13; the reference requires only 5 and ships 12 genuine definitions.
Extra tools are explicitly allowed ("Tool order is irrelevant and extra client
tools are allowed"). Ours works and is stricter than needed — **keep**, but note
we carry one tool (`patch`) the reference does not have a definition for.

### 2.4 Session derivation

Both produce a valid `ses_` id. Different strategies:

- Ours: **time-bucketed** — `stableOpenCodeSessionId` buckets to 6 h with a
  deterministic jitter, so a conversation keeps one id across millisecond
  boundaries and preserves prompt-cache affinity. Fresh ids use a real
  `Date.now()`.
- Reference: **hash-based** — `CanonicalSessionID` = sha256 of a signal, the
  timestamp bits taken from the digest; scoped per server key so two keys never
  share an upstream session. No clock involved.

Ours is better for cache affinity; theirs is better for multi-tenant isolation.
**Keep ours** — we are single-gateway with our own affinity plumbing, and their
scoping solves a problem (many server keys sharing one upstream session) that
our architecture separates differently.

### 2.5 Anonymous lane order

- Ours: `/inference/v1` only.
- Reference: v1 `/zen` **first**, then `/inference` (`upstream.go:428-435`).

They keep a fallback lane we do not have. If `/inference` starts refusing,
they still have `/zen` — but `/zen` needs the *other* identity (v1: different
UA, `x-opencode-request` required), so adopting it means implementing a second
client shape, not just adding a URL. **Not worth it** while `/inference` works.

### 2.6 Free-model classification

- Ours: id ends `-free`, or in `KNOWN_FREE_ZEN_IDS` (`big-pickle`), minus a
  hand-kept `UNAVAILABLE_FREE_ZEN_IDS` blocklist (4 ids).
- Reference: **`isFreeModel` = name contains "free"** (`catalog.go:454`), or
  metadata says cost 0 and not deprecated (`pricing.go:225-300`).

Ours is more precise; theirs auto-adapts to new free models. Our blocklist is
hand-maintained and will drift. Worth a knob, not a rewrite.

### 2.7 What they have that we do not

| Thing | Reference | Ours | Adopt? |
|---|---|---|---|
| Go-plan quota | `GET {upstream.go}/v1/usage`, 3 windows (`model_quotas.go:148`) | **none** — no `loadQuotaCollector` for any opencode row | **Yes** — real gap |
| Rotating proxy pool | `#pool` / `pool+` marker: fresh CONNECT per attempt, never cooled (`pool.go`, `proxy.go`) | per-pool agent | **Partly** — concept maps, see §3 |
| Sticky model groups | `sota` / `sweet` aliases + rotation state | aliases + combos exist | **No** — Go-tier feature, we have no Go keys |
| First-event timeout | hold a 2xx until the first real SSE event (`first_event.go`) | — | Maybe; protects against silent streams |
| Model availability probe | disables a model 24 h on `model_retired` (`availability.go`) | model strikes / bans | Conceptually similar |
| Anonymous cooldown cap | `Retry-After` capped at 8× (`maxAnonymousRetryAfterMultiplier`) | cooldown knobs exist | Worth checking |
| Disk catalog cache | `config.json.models.catalog.json` + `.models.dev.json`, atomic rename | DB-seeded catalog + Redis | **No** — ours is better |

---

## 3. What Bun can do natively (no uTLS, no new dependency)

The reference needed uTLS **because Go's `crypto/tls` cannot change its
ClientHello**. We are on Bun. Bun *is* the thing being impersonated.

| Reference needed | We get for free |
|---|---|
| uTLS + hand-built ClientHello | `fetch()` — measured identical (§0) |
| Custom HTTP/1.1 writer + `bunCommonHeaders` | Bun's own writer |
| Empty `TLSNextProto`, `NextProtos: ["http/1.1"]` | Bun offers `http/1.1` only — measured |
| brotli/zstd/gzip/deflate decode | `fetch` decodes; we also have `node:zlib` |

**So: zero new dependencies.** No uTLS equivalent exists for Bun and none is
needed. `wkwkw` is fair — they wrote ~900 lines of Go (`bun.go` 590 +
`bun_dial.go` 312) to reproduce what `fetch()` already does for us.

### What actually stands in our way

`src/network/outbound-fetch.ts` is built on `node:http`/`node:https`, and it is
there for reasons that are not about TLS:

1. **SSRF guard** — `resolveAllAddresses` / `validateResolvedAddresses`
   (`src/network/ssrf.ts`) must run *after* DNS and *before* connect. Bun's
   `fetch` gives no hook for that.
2. **Pool agent support** — `ProxyAgentPair` (SOCKS5 egress per network pool).
   Bun's `fetch` has no per-request agent.
3. Streaming body plumbing already written against Node streams.

That is the honest trade — not "Bun can't do TLS", but "our Node path carries
SSRF + proxy behaviour that Bun's fetch does not expose".

### Options, cheapest first

1. **Route only free-tier opencode dispatch through `fetch()`.** Narrowest
   change: the one lane where the ClientHello is load-bearing. SSRF still needs
   solving — pre-resolve the host and pin it, or accept `fetch` for a
   known-static host (`opencode.ai`) whose address we validate once.
2. **Keep Node TLS but match what we can.** Header order and `Accept` are
   fixable without touching TLS. Does nothing for the hello.
3. **Do nothing.** The gate accepts us today.

### Measured, after writing this: option 1 does not work

I tried it and backed it out. Three measurements killed it:

1. **Bun `fetch` cannot pin the connect address.** It always resolves the URL
   hostname itself: `fetch("https://nonexistent-host-zzz.invalid/")` fails with
   `getaddrinfo ENOTFOUND` even with `tls.serverName` set. So the SSRF guard —
   resolve, validate, then connect to the *validated* address — has no hook.
   (Node's `lookup` option is exactly the hook; Bun has no equivalent.)
2. **Bun `fetch` does not speak SOCKS5.** `proxy: "socks5://…"` returns
   `UnsupportedProxyProtocol`; only HTTP CONNECT is accepted. Our pools are
   `SocksProxyAgent` (`agent.ts:428`).
3. **A pool is what makes the free tier reachable at all.** `opencode` is the
   only `ipScopedRateLimit` provider, and `.skills/cartethyia-trace-replay`
   states it plainly: a datacenter IP is refused, and "cannot be fixed in
   `provider.ts` — it needs an egress proxy". Routing through Bun would trade
   a correct ClientHello for an egress the gate blocks *before* TLS matters.

A fourth attempt — setting Node's `ciphers` to Bun's list — made it worse, not
better: OpenSSL kept only 3 of the 17 (the rest are unavailable to it) and
rejected `X25519MLKEM768` in `ecdhCurve`. The result was further from Bun than
the default.

So GAP1 is closed as **won't do, with a reason**, not silently skipped.

---

## 4. What to keep (FULL)

Not "keep by default" — each of these is ours being *better*:

1. **Time-bucketed session ids** (§2.4) — real cache affinity; theirs has none.
2. **13-tool fingerprint** (§2.3) — stricter than the gate needs, already
   passing. Stricter is safer than the minimum.
3. **Bundled brotli columnar catalog** (`catalog-format.ts`) — binary search
   over typed arrays, bounded LRU, byte-length check at boot. Their JSON disk
   cache with schema versions and a Windows `.replace` dance is worse.
4. **Hub-and-spoke protocol translation** — one canonical model, N wires. They
   translate pairwise per protocol; we already serve any client surface from
   any provider wire.
5. **DB/Redis catalog caching** with TTL + dedupe, vs their two JSON files.
6. **Omitting `x-opencode-request`** — correct for our lane (§1).
7. **Per-model, not per-provider, free classification** — theirs keys off tier
   and misses `-free` models on other tiers.
8. **SSRF guard on outbound** — they have no equivalent.
9. **Diagnostic requests never touching pool state** — we have the same idea;
   keep it, since a bad probe must not cool a production egress.

---

## 5. Gaps (real, ranked)

1. **TLS ClientHello** (§2.1) — we send OpenSSL's, not Bun's. Unknown whether
   the gate checks it *today*; the reference gateway bet ~900 lines that it
   matters.
2. **No Go-plan quota collector** (§2.7) — `GET /v1/usage` is a documented,
   simple endpoint and we return "not available" for `opencode-go`.
3. **`Accept` value** (§2.2) — one-line fix, matches the real client.
4. **Free-model blocklist is hand-kept** (§2.6) — will drift as upstream adds
   and removes models.
5. **No `/zen` (v1) fallback lane** (§2.5) — costs a second client shape.

---

## 6. How I verified

- ClientHello: raw TCP server + `tls.connect` (Node) and `fetch` (Bun), parsing
  ciphers/extensions/curves/ALPN out of the handshake bytes. Both probes run
  locally, deleted after use.
- Reference claims: read `bun_dial.go`, `bun.go`, `upstream.go`,
  `identity/request.go`, `catalog.go`, `pricing.go`, `config.go`, `pool.go`,
  `rotation/state.go`, `model_quotas.go` and quoted `file:line`.
- Ours: read `provider.ts`, `fingerprint.ts`, `tool-definitions.ts`,
  `outbound-fetch.ts`, `default-registry.ts`.
- Seven parallel research agents; three read the wrong repo (ours instead of the
  Go one) and were re-run with the absolute path. Their output was used only
  where I confirmed it against source myself.

**Not verified:** whether `opencode.ai` currently rejects a non-Bun ClientHello.
That needs a live A/B from the same egress IP — one request via `node:https`,
one via `fetch`, same headers. Everything in §3 depends on that answer, so it
should be measured before anything is changed.

---

## 7. What was actually implemented (2026-10-19)

Of the five gaps, three shipped and two were declined with reasons.

| Gap | Outcome |
|---|---|
| 1 — TLS ClientHello | **Declined.** §3 — would break the egress proxy the free tier depends on. |
| 2 — Go-plan quota | **Shipped.** `opencode-go-quota.ts`, registered on `opencode-go`. |
| 3 — `Accept` value | **Shipped.** Now `application/json, text/event-stream`. |
| 4 — Refused-model list | **Shipped.** `CARTETHYIA_OPENCODE_UNAVAILABLE_FREE`, `none` to trust the listing. |
| 5 — `/zen` v1 fallback | **Declined.** Needs a second client identity — v1 UA plus the `x-opencode-request` we deleted on purpose after it caused 403. Our own skill records `/zen/v1` answering 429. |

Two candidate adoptions turned out to be unnecessary:

- **Anonymous `Retry-After` cap.** Our pool cooldown is a fixed
  `CARTETHYIA_POOL_COOLDOWN_MS` (120 s) and does not read `Retry-After` at all
  (`pool-health-machine.ts:102`). The 24 h ceiling in `failure-policy.ts`
  belongs to the *account* path, not the egress. There is nothing to cap.
- **First-event timeout.** Already exists and is broader:
  `CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS` plus `empty-stream.ts`, which
  also replays an empty stream. The reference only cancels.

---
