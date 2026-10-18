# OpenCode client identity — the session headers, traced from the bundle

> [!NOTE]
> **Part one (the bundle trace) is reference; part two (the measurements) is
> superseded.** Sections up to "What our adapter does" describe what the
> *client* emits and remain accurate. Everything from "Measured 2026-10-17"
> onward is the working log that produced the current contract; the contract
> itself is stated once, in
> [`opencode-free-tier.md`](./opencode-free-tier.md).
>
> This document is still the place to read the generator, the counter window,
> `promptCacheKey`, and the `parentID ?? fork?.sessionID ?? id` derivation.

> [!IMPORTANT]
> **The client sends two different session values, not one.** Our adapter sent a
> single id in all five session headers. That is the defect this document
> records, alongside the generator it was derived from.

**Date:** 2026-10-17. **Build pinned:** `opencode-cli` 2.0.32, extracted from
`opencode-desktop-linux-x86_64.rpm` (`D:/tmp/opencode-rpm/extracted/`).
**Method:** static inspection of the minified bundle. No installer was run.

## The question

OpenCode free-tier dispatches through our adapter intermittently answer
`403 FreeTierError` while the tools, the stream flag, and the anonymous bearer
are all correct. What in the request still differs from what the client sends?

## What the client sends

From `SessionModelRequest.prepare` in the CLI bundle, the request headers are
built in one object:

```js
fH = IR(h)
EH = tJ({
  model: T.model,
  http: {
    headers: {
      "x-opencode-session-id": h.id,
      ...(h.parentID ? { "x-opencode-parent-session-id": h.parentID } : {}),
      "x-session-affinity": fH,
      "X-Session-Id": fH,
      ...(h.parentID ? { "x-parent-session-id": h.parentID } : {}),
      "User-Agent": QA(A),
      "x-opencode-project": h.projectID,
      "x-opencode-session": fH,
      "x-opencode-client": A.name,
    },
  },
  promptCacheKey: /^ses_[0-9a-f]{64}$/.test(fH) ? fH.slice(4) : fH,
  ...
})
```

with

```js
IR = (H) => H.parentID ?? H.fork?.sessionID ?? H.id;
```

### The two values

| Header | Value | Meaning |
| --- | --- | --- |
| `x-opencode-session-id` | `h.id` | **the session's own id** |
| `x-session-affinity` | `fH` | parent session, or the forked session, or the id |
| `X-Session-Id` | `fH` | same as affinity |
| `x-opencode-session` | `fH` | same as affinity |
| `x-parent-session-id` | `h.parentID` | **only when a parent exists** |

For a top-level session `fH === h.id`, so the two collapse into one value. They
diverge in exactly the case that matters: a **child or forked session**, where
affinity points at the parent while `session-id` names the child.

Our adapter emitted one id into all five. For a top-level session that is
indistinguishable from correct; for anything derived, it claims the child is its
own parent.

### The project header

`x-opencode-project` is `h.projectID`. The reference gateway notes the free tier
**refuses canonical `prj_*` ids** and accepts the literal `global` every client
sends, so a real client's project id is not necessarily what the gate wants. Our
adapter sends `global` unless the caller supplies one — that part is fine.

### `promptCacheKey`

```js
promptCacheKey: /^ses_[0-9a-f]{64}$/.test(fH) ? fH.slice(4) : fH
```

A 64-hex session literal is stripped of its `ses_` prefix; any other shape is
passed through whole. Note this is the **64-hex** internal form, not the
26-character wire form.

## The generator

```js
function Q$e() { return gZ(!0) }
function gZ(e, n = Date.now()) {
  if (n !== m) m = n, d = 0;
  d++;
  let r = BigInt(n) * 0x1000n + BigInt(d),
      a = e ? ~r : r,
      c = Array.from({ length: 6 }, (l, D) =>
            Number(a >> BigInt(40 - 8 * D) & 0xffn).toString(16).padStart(2, "0")).join(""),
      s = crypto.getRandomValues(new Uint8Array(F - 12));
  return c + Array.from(s, (l) => I[l % 62]).join("")
}
```

Facts, read off this code rather than assumed:

- The counter `d` **has no upper bound**. It resets when the millisecond
  changes and otherwise grows without limit.
- The value is `~(ts_ms << 12 | counter)` when descending, rendered as 6 bytes
  (12 hex), then 14 base62 characters.
- `Session.ID` is minted by `e.make("ses_" + Q$e())`, so every session id is
  `ses_` + 12 hex + 14 base62.

### What this means for the counter cap

The reference gateway (`opencode2api`) caps the counter at 63, and its comment
claims the gate accepts 1–63 only. **The client does not cap it.** So a cap is a
deliberate divergence from the client, and two things follow:

1. A cap is only correct if the *gate* rejects high counters — a claim about
   upstream, not about the client.
2. Without a cap, a burst of more than 63 dispatches inside one millisecond
   emits ids whose low 12 bits fall below `0xfc0`. Whether upstream refuses
   those is **unverified here**; the reference gateway says it does, from live
   probing.

We capped at 63 and roll into the next millisecond on overflow. That keeps every
id inside the window the reference reports as accepted, at the cost of ids that
do not sort exactly as the client's would under a burst. The alternative — match
the client exactly and emit uncapped counters — is only safe if the gate truly
accepts them.

**Status of this claim: `unverified`.** It rests on another project's live
probing, not on our own measurement.

## What our adapter does, and where it differs

`src/providers/integrations/opencode/fingerprint.ts`:

| Aspect | Client | Ours | Verdict |
| --- | --- | --- | --- |
| distinct `session-id` vs affinity | yes | **one value in all five** | **defect** |
| `x-parent-session-id` | when a parent exists | never sent | **missing** |
| `x-opencode-client` | `A.name` (`cli`) | `desktop` | cosmetic; gate accepts both |
| `x-opencode-project` | `h.projectID` (40 hex) | hashed to 40 hex | **fixed** |
| counter cap | none | 63 | divergence, see above |
| `x-opencode-request` | absent | absent | correct |
| trace headers | from tracing context | freshly generated per call | acceptable |

### Why "one value in all five" is a real defect and not a nit

The affinity header is what upstream uses to group a conversation for prompt
caching and for whatever per-session accounting the free tier applies. Sending
the child's id as its own affinity:

- splits a forked conversation into two unrelated sessions upstream, losing
  cache affinity — the thing the header exists for;
- makes a child look like a root, so any per-session limit the gate applies is
  counted against the wrong identity.

For a top-level session — which is every dispatch our adapter currently
produces, because nothing sets a parent — the two values are identical, so the
bug is **latent, not active**. It becomes active the moment anything routes a
derived session through this adapter.

## Corrections to earlier notes

The capture document (`documentation/archive/opencode-freetier-replay.md`)
records the four session headers as carrying the *same* id. That is true of the
captured top-level session and was generalised from it. The bundle shows the
general rule: they are equal only when no parent exists.

## What is still unknown

- Whether the gate actually rejects counters above 63. Only the reference
  gateway asserts it.
- Whether the gate compares `x-opencode-session-id` against affinity at all, or
  merely uses affinity for cache grouping. The bundle proves what the *client*
  sends; it says nothing about what upstream checks.
- Whether `x-opencode-client: desktop` versus `cli` matters. Earlier probing says
  both are accepted; the bundle's `A.name` is the client's own name, which for
  the CLI is `cli`.

## Next evidence needed

1. Replay a dispatch with `session-id` and affinity deliberately different, from
   an allowed egress, and observe whether the gate accepts it. That is the only
   way to learn whether the distinction is enforced.
2. Replay 64+ ids minted inside one millisecond and observe the status of the
   later ones. That settles the counter cap.
3. Only then change the adapter. A diff against another client's source is a
   hypothesis, not evidence.

## Addendum — the project header

The captured 2.x dispatch carries:

```
x-opencode-project: 82b484de3985b491abf573de7d60d7999302b858
```

40 hex, not a name. Our adapter sent the literal `"global"` — a value that
passed one earlier probe, but which is not the shape the client produces. The
reference gateway (`opencode2api`) reaches the same conclusion from its own
probing and renders the header as `sha256(project)[:20]` hex, noting that the
free tier **refuses canonical `prj_*` ids** while accepting the 40-hex form.

We now do the same: a caller's project identity is hashed into 40 hex, and an
already-canonical value is preserved rather than re-hashed.

### Why "global" was not obviously wrong

It passed a live probe on 2026-10-14, so it looked correct. A value that is
accepted is not the same as a value that is sent — the gate may tolerate several
shapes while fingerprinting only one. Treating "this passed" as "this is the
client's value" is how a guess becomes a constant.

## Addendum — what the reference gateway does differently, and why it is not proof

`opencode2api` sets `x-opencode-session`, `x-session-affinity`, `X-Session-Id`,
and `x-opencode-session-id` all to the **same** derived id, with a comment
saying the newer gate "wants both session headers set to the same
descending-encoded id".

That contradicts the bundle, which builds them from two expressions
(`h.id` versus `IR(h)`). Both can be true: the gate may accept one value in all
five for a top-level session — which is every session a stateless gateway
produces, because it has no parent to derive from — while the client still
distinguishes them for its own forked sessions.

So the reference is evidence that **one value works**, not evidence that the
distinction is irrelevant. Our adapter keeps one value for now: it produces only
top-level sessions, where the two expressions are identical by definition. The
distinction becomes load-bearing only if we ever forward a parent relationship,
and at that point the bundle is the authority.

## Measured 2026-10-17 — the open questions, answered

Run from five fresh egresses that all answered `200` on the same dispatch, so
every result below is about the header, not the address.

### The counter window is real, and the cap is correct

| Counter | Time part | Result |
| --- | --- | --- |
| 1 | `eb532e04bffe` | **200** |
| 63 | `eb532e04bfc0` | **200** |
| 64 | `eb532e04bfbf` | **403 FreeTierError** |
| 100 | `eb532e04bf9b` | **403** |
| 4095 | `eb532e04b000` | **403** |

The boundary is exactly where the reference gateway said it was: **1–63
accepted, 64 and above refused**. This was previously recorded as another
project's claim; it is now our own measurement, and the cap in
`generateOpenCodeSessionId` is what keeps a burst from crossing it.

### The session shape is enforced, the value is not

| Variation | Result |
| --- | --- |
| baseline (our headers) | 200 |
| `x-opencode-client: cli` instead of `desktop` | 200 |
| 64-hex internal session literal | **403** |
| `x-opencode-session-id` ≠ affinity, with parent headers | 200 |
| `x-parent-session-id` present | 200 |

So the gate checks the **shape** — `ses_` + 12 hex in the descending layout +
14 base62 — and does not care whether `session-id` equals affinity, nor whether
a parent header is present. The bundle's distinction is real for the client's
own bookkeeping, but nothing upstream enforces it.

That closes the item left open earlier: our adapter sending one id in all five
is **not** a defect the gate can see. It stays a latent correctness issue for
cache affinity if we ever forward a parent relationship, not a 403 cause.

### The project header is not validated in any of the forms we tried

| Variation | Result |
| --- | --- |
| 40-hex (our current value) | 200 |
| literal `global` | 200 |
| header absent entirely | 200 |

The reference gateway's claim that canonical `prj_*` ids are refused was not
re-tested, but every other shape passed. The 40-hex form is still what we send:
it is what the client produces, and matching the client is the safer default
even where the gate is indifferent.

### What this rules out

The intermittent `403`s are **not** caused by:

- the session counter (capped, and the cap matches the measured window);
- `x-opencode-client` (`desktop` and `cli` both pass);
- the session-id/affinity split (not enforced);
- the project header shape (three shapes pass).

What remains, and is consistent with the observed pattern — some proxies work
and others refuse the same dispatch — is that the refusal follows the **egress
address**. Five fresh proxies answered 200 on the first try; the earlier set,
used repeatedly during testing, answered 403 to the identical request.

That is the conclusion the free-tier reference already reached, now measured
here: the gate checks the IP first and independently of the request.

## The User-Agent — measured, and it contradicts the capture

The captured dispatch carries `user-agent: opencode/latest/cli`. Sending that
exact value today answers **403 FreeTierError**. Adding a version segment makes
the identical request answer 200.

| User-Agent | Result |
| --- | --- |
| `opencode/latest/cli` (the capture's value) | **403 FreeTierError** |
| `opencode/latest/2.0.32/cli` (ours) | 200 |
| `opencode/2.0.32/cli` | 200 |
| `opencode/latest/2.0.26/cli` | 200 |
| `opencode/1.18.31/cli` | 200 |
| `opencode/latest/99.99.99/cli` | 200 |
| `curl/8.0` | 403 |
| empty | 403 |
| `opencode/latest/0.0.1/cli` | **426 UpgradeRequired** |
| `opencode/latest/1.0.0/cli` | **426 UpgradeRequired** |
| `opencode/latest/1.18.0/cli` | 200 |

Reproduced on three independent fresh egresses, so it is the header and not the
address.

The 426 body states the rule outright:

```json
{"type":"error","error":{"type":"UpgradeRequired",
 "message":"OpenCode 1.18.0 or newer is required to use the free tier"}}
```

### What this means

- The UA must be `opencode/<channel>/<version>/cli` with a **version segment**.
  `opencode/latest/cli` has two segments where three are expected, and the gate
  refuses it as a 403 rather than explaining.
- The version floor is **1.18.0**. Below it the gate says so politely with 426.
- Above the floor the exact number does not matter: 1.18.0, 1.18.31, 2.0.26,
  2.0.32 and 99.99.99 all pass.
- The capture is **stale on this field**. It was taken from a client that sent
  the two-segment form, and upstream has since tightened to three. This is the
  clearest example yet of why a captured value is evidence about one moment,
  not a constant.

Our adapter already sends the three-segment form
(`opencode/latest/<version>/cli`), so no change is needed. The finding matters
because the capture document tells a reader to match `opencode/latest/cli`
exactly — following it today would produce a 403 that looks like an IP block.

### Not the cause of the intermittent 403s

Our UA already had the version segment, and the old egresses refused it while
the fresh ones accepted the identical header. So the UA is a real rule, but it
is not what separates a working proxy from a blocked one.

## The tool set — the capture's threshold is stale too

The capture records that 10–11 of the client's 13 tools are required and that a
five-tool subset is refused. Measured today on fresh egresses, that is wrong:

| Tools sent | Result |
| --- | --- |
| 0 | **403** |
| 1 | **403** |
| 2 | **403** |
| 3 | 200 |
| 4 | 200 |
| 5 | 200 |
| 9 | 200 |
| 11 | 200 |
| 12 | 200 |
| 13 | 200 |

The floor is **3**, not 10. The gate checks that the request is agent-shaped,
not that it carries the client's exact roster.

We still send all 13. The floor being lower is a fact about the gate, not an
invitation to send less: the whole point of this adapter is to look like the
client, and the client sends its full set.

### And streaming is still mandatory

| Body | Result |
| --- | --- |
| `stream: true` | 200 |
| `stream: false` | **403** |

Unchanged from the capture. The gate refuses a non-streamed free dispatch
outright.

## What the capture got right, and what has drifted

| Claim in the capture | Status today |
| --- | --- |
| `Authorization: Bearer public` required | **still true** |
| base URL `/inference/v1` | **still true** |
| `stream: true` required | **still true** |
| four session headers required | **still true** |
| full 10–11 tool set required | **stale — floor is 3** |
| `user-agent: opencode/latest/cli` | **stale — needs a version segment** |
| `x-opencode-request` must be absent | still true |
| `/zen/v1` refused | not re-tested |

Two of the eight fields this document was built on have moved. That is the
argument for treating a capture as a snapshot with a date, not as a contract.

## What the gate does *not* check

Measured on fresh egresses. Each row is a dispatch that answered **200**, so the
variation is tolerated rather than merely untested.

| Variation | Result |
| --- | --- |
| prompt of 8,000 characters | 200 |
| 20-turn conversation | 200 |
| a `system` turn prepended | 200 |
| `temperature: 0.2` | 200 |
| `top_p: 0.9` | 200 |
| no `max_completion_tokens` | 200 |
| trace headers absent | 200 |
| trace headers malformed (`traceparent: garbage`) | 200 |
| `x-opencode-request` present | **200** — no longer refused |
| 8 concurrent dispatches | 200 all |
| 12 sequential dispatches | 200 all |

Two of these contradict the capture outright:

- **`x-opencode-request` no longer breaks `/inference`.** The capture records it
  as flipping an otherwise-200 request to 403. It does not, today. We still do
  not send it — the client does not, and there is no reason to reintroduce a
  header that once mattered.
- **Trace headers are not validated.** We generate `traceparent`/`b3` per call;
  the gate accepts them absent or malformed, so their content is free.

## The `/zen/v1` lane answers 429, not 403

| Endpoint | Result |
| --- | --- |
| `/inference/v1/chat/completions` | 200 |
| `/zen/v1/chat/completions` | **429 `FreeUsageLimitError`** |

The capture records `/zen/v1` as refused with 403 for the free tier. Today that
lane is alive and rate-limited, which is a different fact: a 429 means the lane
accepted the request and the allowance is spent. It says nothing about the
request shape.

We stay on `/inference/v1` — it is the lane the current client uses, and the one
that answers 200 for a free dispatch.

## Volume is not what triggers a refusal

Twelve sequential dispatches through one fresh proxy, then eight concurrent
through another, all answered 200. So a burst is not by itself what retires an
address.

That leaves the observation that started this investigation unexplained rather
than solved: five proxies used repeatedly during a long session ended up
answering 403 to requests identical to the ones five new proxies accepted. Two
candidate explanations remain, and this document does not choose between them:

1. The gate accumulates something per address over a longer horizon than a
   dozen requests — a daily or per-hour allowance on the *address*, distinct
   from the per-request checks above.
2. Those particular proxies were already retired for reasons outside this
   gateway's traffic.

Distinguishing them needs the same proxy measured across hours, or an address
whose history is known before it is used. Neither was available here.

## The header set is far smaller than we send

Dropping one header at a time from the full set, every single one answers 200 —
**including `authorization`**. Only `user-agent` is load-bearing on its own.

| Dropped header | Result |
| --- | --- |
| `content-type` | 200 |
| `x-opencode-client` | 200 |
| `x-opencode-session` | 200 |
| `x-opencode-session-id` | 200 |
| `x-session-affinity` | 200 |
| `x-session-id` | 200 |
| `x-opencode-project` | 200 |
| `traceparent` | 200 |
| `b3` | 200 |
| **`authorization`** | **200** |
| `accept` | 200 |
| **`user-agent`** | **403** |

Each header is individually redundant, which is not the same as being
unnecessary: the gate requires a *set*, and removing any one member leaves the
others satisfying it.

### What the set actually is

| Headers present | Result |
| --- | --- |
| UA only | **403** |
| UA + `content-type` | **403** |
| UA + `authorization` | **403** |
| UA + `accept` | **403** |
| UA + `x-opencode-session` | **200** |
| UA + `x-session-affinity` | **200** |
| UA + `x-session-id` | **200** |
| UA + `x-opencode-session-id` | **403** |
| UA + `x-opencode-session` + anything else | 200 |
| all session headers, no UA | **403** |

So the minimum is **`user-agent` plus at least one of
`x-opencode-session` / `x-session-affinity` / `x-session-id`**. The other two
session headers — including `x-opencode-session-id`, the one whose value the
client derives separately — do not satisfy the check on their own.

That is a genuine asymmetry, and it is the first evidence about *which* header
the gate reads: it reads one of the three affinity-style names, not the
`session-id` one.

### The session value is validated, not just present

| Value | Result |
| --- | --- |
| `ses_<valid descending layout>` | 200 |
| `not-a-session` | **403** |
| empty | **403** |

So the header must be present **and** carry a well-formed session id. Presence
alone is not enough — which is why the earlier "drop one header" sweep, where
the remaining headers still held a valid id, could not distinguish these cases.

### What this means for us

We send all five session headers plus the UA. That is a superset of the
minimum, and it is the right thing to keep sending: the client sends all of
them, and this adapter's job is to look like the client. The measurements matter
for the opposite reason — they show which single header a future change must not
drop, and they explain a 403 that would otherwise look like an address problem.

## Three sources, compared header by header

The client capture, the reference gateway (`opencode2api`, Go), and our adapter
disagree in ways worth writing down. Each row was sent live on 2026-10-17
through a fresh egress.

| Header | Real client (capture) | Reference gateway | Ours (before) | Ours (now) |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer public` | `Bearer <key>`, `public` for free | `Bearer public` on free only | unchanged |
| `content-type` | `application/json` | `application/json` | `application/json` | unchanged |
| `accept` | `*/*` | `application/json, text/event-stream` | `text/event-stream` (free) | unchanged |
| `user-agent` | `opencode/latest/cli` *(stale)* | `opencode/latest/<ver>/cli` | `opencode/latest/<ver>/cli` | unchanged |
| `x-opencode-client` | `cli` | `cli` | **`desktop`** | **`cli`** |
| `x-opencode-session` | `ses_…` | `ses_…` | `ses_…` | unchanged |
| `x-opencode-session-id` | `ses_…` | `ses_…` | `ses_…` | unchanged |
| `x-session-affinity` | `ses_…` | `ses_…` | `ses_…` | unchanged |
| `x-session-id` | `ses_…` | `ses_…` | `ses_…` | unchanged |
| `x-opencode-project` | 40 hex | 40 hex | 40 hex | unchanged |
| `b3` / `traceparent` | present | not sent | present (random) | unchanged |
| `x-opencode-request` | **absent** | absent on `/inference` | absent | unchanged |
| `x-parent-session-id` | absent | only when forked | absent | unchanged |
| `connection` / `accept-encoding` | `keep-alive` / gzip… | Go defaults | runtime defaults | unchanged |

All three sets answered **200**. The differences are therefore about matching
the client, not about passing the gate.

### The one real divergence: `x-opencode-client`

We sent `desktop`. Every source says `cli`:

- the captured 2.x dispatch: `"x-opencode-client": "cli"`;
- the local 2.0.26 CLI captures recorded in
  [`opencode-cache-replay.md`](./opencode-cache-replay.md): `cli`;
- the reference gateway: `req.Header.Set("x-opencode-client", "cli")`.

The old code comment claimed `desktop` "matches the identity the observed
free-tier traffic carries". Nothing in the archive supports that, and the
capture file in the same directory contradicts it. The gate accepts both, so
this was never a 403 — it was an adapter claiming to be a client it is not.
Now `cli`, matching all three sources.

### Where we deliberately keep a difference

- **`accept: text/event-stream`** — the client sends `*/*`; the reference sends
  both types. Ours is narrower, which is honest: we only ever want SSE, and
  `stream: false` is refused anyway. Both other values measured 200.
- **`traceparent` / `b3`** — we generate them per call and the gate does not
  validate them (absent or `garbage` both pass). The reference sends neither.
  Kept because the client sends them and they cost nothing.
- **No `x-opencode-request`** — all three agree.

### Two reference claims our measurements contradict

| Reference says | Measured 2026-10-17 |
| --- | --- |
| keyless dispatch is refused (403) | **no `authorization` answers 200** on three egresses |
| `Bearer PUBLIC` 401s (case-sensitive) | **confirmed** — `Bearer PUBLIC` and `Bearer garbage` both 401 |
| canonical `prj_*` project ids are refused on `/inference` | **`prj_<24hex>` answers 200** |
| `x-opencode-request` is rejected on `/inference` | **answers 200** |

The `authorization` row is the surprising one. A *wrong* credential is rejected
with 401 — so the header is read when present — but an *absent* one passes. That
is consistent with the gate treating `public` as the anonymous default rather
than as a credential it requires. We keep sending it because all three sources
do, and because the free tier may tighten again.
