# OpenCode free tier — the contract, measured

> [!IMPORTANT]
> **This is the entry point.** It states what the gate accepts *today*, how to
> replay it, and how the current beliefs got here. Everything else in this
> directory is history or a method:
>
> | Document | What it is |
> | --- | --- |
> | [`opencode-freetier-replay.md`](./opencode-freetier-replay.md) | 2026-10-14, the first 200 OK: how the capture was taken, how the artifacts were opened, why bisecting failed |
> | [`opencode-session-identity.md`](./opencode-session-identity.md) | The bundle trace behind the session headers: the generator, the counter, `promptCacheKey` |
> | [`opencode-cache-replay.md`](./opencode-cache-replay.md) | 2026-10-13, prompt-cache reads on `/zen/v1` before any of this was understood |
> | [`opencode-egress-probing.md`](./opencode-egress-probing.md) | The `probe:egress` tool and how to classify an egress |
> | [`opencode-freetier-capture.log`](./opencode-freetier-capture.log) | The raw captured dispatch. One field in it is stale — see the timeline |
>
> A capture is a photograph of one moment. Three of the values recorded in the
> 2026-10-14 capture no longer pass. Read the dated sections here before
> trusting any raw artifact.

---

## 1. The contract

`POST https://opencode.ai/inference/v1/chat/completions`, `big-pickle`, from an
egress the gate has not retired. Measured 2026-10-18, each row reproduced on at
least three independent egresses.

### Required

| Field | Value | Failure mode |
| --- | --- | --- |
| `user-agent` | `opencode/<channel>/<version>/cli`, **version ≥ 1.18.0** | two segments → `403 FreeTierError`; below the floor → `426 UpgradeRequired` |
| one affinity header | `x-opencode-session`, `x-session-affinity`, or `x-session-id` carrying a well-formed `ses_` id | absent → 403; malformed → 403 |
| `stream` | `true` | `false` → 403 |
| `tools` | at least **3** | 0/1/2 → 403 |

The session id is `ses_` + 12 hex + 14 base62, where the hex is the inverted
`(ms << 12 | counter)` and **the counter must be 1–63**. Counter 64 answers 403.
See [`opencode-session-identity.md`](./opencode-session-identity.md#the-generator).

### Not required

Every one of these can be dropped from an otherwise-valid dispatch without
changing the status:

`authorization`, `content-type`, `accept`, `x-opencode-client`,
`x-opencode-project`, `traceparent`, `b3`, `x-opencode-request`, and any
*individual* session header.

Two of those deserve emphasis, because both were recorded as required and both
are wrong:

- **`authorization`.** A dispatch with no `Authorization` at all answers 200. A
  *wrong* one does not: `Bearer PUBLIC` and `Bearer garbage` answer **401**.
  So the header is read when present and defaults to the anonymous identity when
  absent. We send `Bearer public` anyway — the client does, and the lane may
  tighten again.
- **`x-opencode-request`.** Recorded as flipping 200 → 403. It answers 200
  today. We still do not send it, because the client does not.

> **Dropping one header proves less than it looks.** The gate wants a *set*; a
> single removal leaves the others satisfying it. The real minimum is
> `user-agent` plus **one** affinity header. `x-opencode-client` alone, or
> `authorization` alone, is not enough.

### Checked for shape, not for value

| Field | Accepted | Refused |
| --- | --- | --- |
| session id | any `ses_` + 12 hex (counter 1–63) + 14 base62 | 64-hex literal, `not-a-session`, empty |
| project | 40 hex, `global`, `prj_<24hex>`, or absent | — none observed |
| user-agent version | 1.18.0 … 99.99.99 | below 1.18.0 (426) |
| tool count | 3 … 13+ | 0–2 |
| `x-opencode-client` | `cli` or `desktop` | — |
| `session-id` vs affinity | equal or different | — |

### Not checked at all

Measured 200: an 8,000-character prompt, a 20-turn history, a prepended
`system` turn, `temperature`, `top_p`, a missing `max_completion_tokens`,
`traceparent`/`b3` absent or literally `garbage`, `x-opencode-request` present,
`x-parent-session-id` present, 12 sequential dispatches, 8 concurrent
dispatches.

---

## 2. Two failures that look identical

This is the expensive confusion, and it has cost this project more time than
any single field.

| Symptom | Cause | Fix |
| --- | --- | --- |
| 403 `FreeTierError` from **every** shape, including a byte-exact replay | The **egress IP** is retired | Nothing in the request. Change the egress. |
| 403 on one shape, 200 on another, same egress | The request shape | Fix the field. |

**Check the IP first.** Measured 2026-10-17: five proxies that had served
hundreds of requests answered 403 to the identical request that five fresh
proxies accepted. The gate checks the address before it looks at the request.

Use `bun run probe:egress --proxy <host:port>`; see
[`opencode-egress-probing.md`](./opencode-egress-probing.md). Volume is *not*
what retires an address — 12 sequential and 8 concurrent dispatches through a
fresh proxy all answered 200 — so the trigger is on a longer horizon than a
burst. See "Still open".

---

## 3. Replay it

Runnable with `bun` and one working egress. Nothing here needs the client.

```ts
import { buildProviderProbeRequest } from "./src/providers/provider-probe";
import { buildOpenCodeHeaders } from "./src/providers/integrations/opencode/fingerprint";
import { createHttpProxyAgent } from "./src/network/pool/agent";
import { createValidatedFetch } from "./src/network/outbound-fetch";

const spec = await buildProviderProbeRequest("opencode");
const dial = createValidatedFetch({
  agent: createHttpProxyAgent("http://host:port", undefined, undefined as never),
});

const headers = {
  ...buildOpenCodeHeaders("2.0.32", "aff_probe"),
  authorization: "Bearer public",
  accept: "text/event-stream",
};

const res = await dial(spec.url, {
  method: "POST",
  headers,
  body: JSON.stringify(spec.body),
  signal: AbortSignal.timeout(30_000),
});
console.log(res.status, (await res.text()).slice(0, 80));
```

`buildOpenCodeHeaders` emits the full client set — five session headers, the
three-segment User-Agent, a 40-hex project, and the trace pair. It deliberately
omits `authorization`, which the adapter adds for free models.

To bisect, change **one** thing per run and keep the egress fixed. Two rules
learned the hard way:

- Do not use `curl` on Windows: it intermittently exits 43 with HTTP 000 on
  CONNECT and looks like a dead proxy. Use `fetch`.
- Do not conclude "this field does not matter" from a 403 unless every other
  field is already known-good. That mistake produced three of the corrections
  in §5.

---

## 4. Timeline

### 2026-10-13 — the cache replay

`POST /zen/v1/responses` with `muse-spark-1.2-contributor-free` returned
measurable prompt-cache reads: an identical 5,695-token input reported 5,617
cached tokens on the second and third call. Rotating `x-opencode-session` did not
prevent the hit; `prompt_cache_key` made no difference either way.

What it established: the lane serves cache hits for a hand-built request. What
it did not: that the request matched a client, since no client was captured.
Recorded in [`opencode-cache-replay.md`](./opencode-cache-replay.md).

### 2026-10-14 — the first 200 OK

MITM was impossible: `opencode.exe` is a self-contained binary that ignores
`HTTP_PROXY`, `HTTPS_PROXY` and `NODE_OPTIONS=--require`. What worked was
redirecting the provider through OpenCode's **own config** to a local server.

That capture is the authority for the client's shape. It is also the source of
most of the stale values — it recorded a client that no longer exists upstream
of it.

Five defects were fixed together to reach 200, which is why single-variable
bisecting had never worked:

1. wrong base URL (`/zen/v1` instead of `/inference/v1`);
2. no anonymous `Authorization`;
3. too few tools;
4. `x-opencode-request` sent;
5. session/project shapes wrong.

### 2026-10-16 — the clamp that ate the fingerprint

`ensureFreeAgentRequest` backfilled the tool set, then `clampOpenCodeTools` kept
only tools the conversation referenced and trimmed the rest away. The dispatch
ended up with zero fingerprint tools and 403'd. The failure read as "the adapter
forgot to add them" when it had added them and thrown them away.

### 2026-10-17 — the egress IP

The decisive discovery. The same byte-identical request answers 403 direct and
200 through a proxy with a different exit address. Confirmed against four
independent implementations: the official client with its real config, the same
client after OAuth login, the stored OAuth token used directly, and the
reference gateway run as-is.

Everything measured before this date was measured from one address and is
therefore a statement about that address, not about the wire.

### 2026-10-17 — the bundle trace

Static inspection of the 2.0.32 CLI bundle: the client sends **two different
session values**, not one (`x-opencode-session-id` = `h.id`, the affinity
headers = `h.parentID ?? h.fork?.sessionID ?? h.id`). For a top-level session
they collapse; for a fork they diverge. The counter generator has **no cap**.

Consequences, both applied: session ids are capped at 63 with roll-forward into
the next millisecond, and the project header became 40 hex.

### 2026-10-18 — the measurement sweep

Everything above had been inferred or inherited. This sweep measured it, on
five fresh egresses that all answered 200 on the same dispatch.

- **The User-Agent rule.** `opencode/latest/cli` — the capture's own value —
  answers **403**. The gate wants three segments and a floor of 1.18.0; below it
  the upstream explains itself with `426 UpgradeRequired` and the message
  "OpenCode 1.18.0 or newer is required to use the free tier". Above the floor
  the number is indifferent.
- **The tool floor is 3, not 10.** The capture recorded 10–11 of 13 required and
  a five-tool subset refused. 0/1/2 answer 403; 3 through 13 all answer 200.
- **The header minimum is two.** UA plus one affinity header. `authorization` is
  droppable; a wrong one 401s.
- **The counter window is 1–63.** Counter 63 → 200, 64 → 403. The cap added on
  2026-10-17 now rests on our own evidence rather than another project's
  comment.
- **Most fields are not checked at all.** See §1.
- **`/zen/v1` answers 429, not 403.** `FreeUsageLimitError` — the lane is alive
  and rate-limited, not refused.
- **`x-opencode-client` was wrong.** We sent `desktop`; the captured dispatch,
  the local 2.0.26 CLI captures, and the reference gateway all say `cli`. The
  gate accepts both, so it was never a refusal — it was the adapter claiming a
  client identity no captured traffic ever carried.

---

## 5. Corrections ledger

Claims this investigation made, and what replaced them. Kept because the same
mistakes are easy to repeat.

| Claim | Status | What is true |
| --- | --- | --- |
| "The credential is bound to runtime state; replay cannot work" | **wrong** | The lane is anonymous and gated on request shape |
| "`Bearer public` is inert" | **wrong** | Absent passes; *wrong* answers 401 |
| "Without `authorization` → 403" | **wrong** | 200 on three egresses |
| "10–11 tools required, 5 is not enough" | **stale** | Floor is 3 |
| "`user-agent: opencode/latest/cli`" | **stale** | Needs a version segment; floor 1.18.0 |
| "`x-opencode-request` flips 200 → 403" | **stale** | Answers 200 on `/inference` |
| "`/zen/v1` is refused with 403" | **wrong** | 429 rate limit; the lane is alive |
| "`x-opencode-project: global` is what the client sends" | **wrong** | The client sends 40 hex |
| "`x-opencode-client: desktop` matches observed traffic" | **wrong** | Every source says `cli` |
| "`x-opencode-session-id` and affinity must match" | **not enforced** | The distinction is real in the client, invisible to the gate |
| "The gate rejects canonical `prj_*` ids" | **not reproduced** | `prj_<24hex>` answers 200 |
| "The gate validates the client version" | **partly** | A floor of 1.18.0, then indifferent |

The pattern behind most of these: a 403 was observed while more than one field
was wrong, and the last-changed field took the blame.

---

## 6. Still open

1. **What retires an address, and over what horizon.** Volume within a session
   is not it: 12 sequential and 8 concurrent dispatches all passed. Either the
   gate accumulates per address over hours, or those particular proxies were
   retired for reasons outside our traffic. Telling these apart needs one
   address measured across a day, or an address whose history is known before
   use.
2. **`/zen/v1` recovery.** It answered 429 rather than 403, so the lane exists.
   Whether it recovers on its own, and with what quota, is unmeasured.
3. **Whether the gate ever tightens again.** Three of the capture's values have
   already moved. Assume more will.

---

## 7. What we send, and why

Our adapter sends a superset of the minimum: five session headers, the
three-segment User-Agent, a 40-hex project, the trace pair, and
`Bearer public` for free models. That is deliberate — the job is to look like
the client, not to send the least that passes.

The measurements matter for the opposite reason: they say which single field a
future change must not drop, and they separate a shape refusal from an address
refusal before anyone starts editing headers.

| Deliberate difference | Why |
| --- | --- |
| `accept: text/event-stream` instead of the client's `*/*` | We only ever want SSE, and `stream: false` is refused anyway |
| Trace headers generated per call | The client sends them; the gate ignores them; they cost nothing |
| Counter capped at 63 | The client does not cap, but the gate refuses 64+ |
| No `x-opencode-request` | The client does not send it |
