---
name: cartethyia-trace-replay
description: "Attribute a failing request to one field: replay it verbatim, bisect until it turns 200, fix the owning layer, prove the flip. Use for a Request Detail, error envelope, 4xx/5xx trace, or payload dump — plus remote debugging against a live gateway with the default API key."
---

# Trace replay and bisection

Use when a request failed and the cause is not yet pinned to a specific field.
The seam map — wire families, the canonical model, and where a dialect is
applied — is `references/protocol-and-translation.md`.

Method: **reproduce the exact failure, then remove one thing at a time until it
turns 200.** The field whose removal flips the status is the cause. Do not stop
at a plausible-looking suspect — a parameter that "should" matter and one that
does are different things, and this method is cheap enough to settle it.

This method attributed a `400 model_param_invalid` on a 3.16M-char prompt to an
**absent** `max_tokens` — not to payload size and not to `reasoning_effort`,
both of which looked like better suspects.

## Steps

1. **Reproduce verbatim** — send the captured body unchanged. If it does not
   fail, you do not yet have the failure. Find out why before bisecting
   (different route, key, or deployment state).
2. **Repeat the baseline.** A single 400 may be transient; replay it several
   times (three is a useful starting point) and confirm the same failure before
   bisecting. Repeated failures establish a reproducible baseline, not proof
   that every run will fail. Change one variable per step.
3. **Bisect** on the full payload — strip optional controls one at a time
   (`prompt_cache_key`, `reasoning_effort`, `stream_options`, `thinking`,
   `reasoning_summary`), then shrink size, then **add** the field you suspect is
   missing.
4. **Attribute** the field to its owner in this repo (below), and fix there.
5. **Prove the flip** against a real instance, and prove the test locks it.

## When the cause is absent, not present

Bisect-by-removal finds a field that is *wrong*. It cannot find a field that is
**missing**, and worse, removal can flip a status for the wrong reason — strip
`tools` to shrink a body and a gate that reads `tools` membership changes its
answer, which reads like "size" or like a tool-shape bug.

Two tells that the arm is a membership test rather than a field value:

- **Adding** the suspected thing fixes it (not removing it).
- The gate accepts the required set **alongside** unrelated entries — it is
  "contains", not "equals". If 11 required names plus 128 foreign ones still
  pass, nothing needs to be dropped.

So when removal has not isolated the cause within a few arms, run the mirror
experiment: take the minimal known-good set, then add one thing at a time to the
failing body. The thing that turns 200 is the gap.

Then check the **pipeline that produces the payload**, not just its final shape.
A backfill that adds a required field and a later clamp/trim/dedupe that removes
it compose into a payload with neither — both sites look correct in isolation.
Reproduce by emulating each stage in order over the captured body and printing
what survives each one.

Gates known to work this way: OpenCode's free tier reads an agent-tool
fingerprint set out of `tools` — see
[`references/opencode-free-tier.md`](references/opencode-free-tier.md).

## Read the decisive test

Same failing body, only that field varies:

| Variation | Reading |
|---|---|
| No `max_tokens` fails, `max_tokens=1` passes | Upstream rejects the **absent** field, not its magnitude |
| Fails at every value | The field is wrong, not missing |
| Passes small, fails large | Size-bound — binary-search the threshold |

Binary-search rather than guessing: known-good low, known-bad high, halve until
they meet. A sharp threshold is a real bound; a fuzzy one usually means you are
not measuring the right variable.

Read the provider's own response/code, not just the gateway's. When retained,
`details.providerCode` may carry it (`model_param_invalid`, `11133`, `11148`);
the public `message` is often generic and names nothing.

**Guard against the size red herring.** A large failing payload makes you
suspect size. Before concluding that, add a tiny explicit limit: 3.16M chars +
`max_tokens=1` returning 200 proves size was never the bound. A field whose
*presence* fixes it is the cause, however large the payload.

## Where the owner usually is

| Suspect | Owner |
|---|---|
| Output-limit fields | `WIRE_TOKEN_BOUNDS` / `resolveWireMaxTokens` in `src/transport/translation/quirks.ts` |
| Chat body | `canonicalToChatPayload` in `src/protocol/request/chat.ts` |
| Responses body | `canonicalToResponsesPayload` in `src/protocol/request/responses.ts` |
| Provider-specific hooks | `buddyPrePayloadCommon` in `src/providers/integrations/buddy/buddy-chat-shared.ts`, and each adapter's `prePayload` |
| Error mapping/classification | `mapUpstreamHttpError` in `src/transport/failure-policy.ts` |
| `tools` array membership / trim | `clampOpenCodeTools` and `ensureFreeAgentRequest` in `src/providers/integrations/opencode/provider.ts` |
| Free-tier refusal (403 `FreeTierError`) | the adapter's fingerprint set, not auth — see [`references/opencode-free-tier.md`](references/opencode-free-tier.md) |

A call site that consults the bound table **only when the caller sent a value**
forwards an omitted field as absent. Look for `if (typeof x === "number")`
guards around a resolver that also owns a default: the default exists but is
unreachable. That is the shape of this bug class.

Fix the owner, not the adapter that reported it, so every upstream on that wire
gets the guard.

## Image and video replay

Identify the listener before bisecting. `Get-NetTCPConnection -LocalPort 12800
-State Listen` reports a process id, not its command line; inspect
`OwningProcess` to confirm it is `bun run --hot src/main.ts`. `dist/cartethyia.exe`
or a cached adapter answers with the old payload. Do not assign `$pid` in
PowerShell; it is read-only.

Capture the body at the last boundary that still owns it. For Codex, compare
the object passed to `postUpstreamJson` with the string inside `pinnedFetch`.
If both contain `tools` and the upstream still says `tool_choice` must be
specified with `tools`, the body is not the cause. Replay that body directly
only when authorized.

A 200 chat response is not an image. Proof is an `image_generation_call` or
`inlineData` whose decoded bytes start with `89 50 4E 47` (PNG) or `FF D8 FF`
(JPEG). Wire owners and account-boundary errors are in the
[provider-catalog skill](../cartethyia-provider-catalog/SKILL.md).

A 403 or chat-only 200 from `cli-chat-proxy.grok.com` is not necessarily a
payload bug, and the checked-in Grok integration does not implement the console
video flow. Re-check the endpoint and auth with an authorized probe before
changing an adapter.

## Wire bytes and payload capture

When the failure needs the actual bytes rather than a bisect, read
`references/payload-and-tracing.md` — frame layout, the four surfaces to
compare, SSE replay, and what must never be logged.

## Remote debugging

The first-boot setup seeds a tenant API key from `CARTETHYIA_API_KEY` (or
generates one). Requests authenticate against the persisted key, not an
environment fallback, and that key gets `TENANT_KEY_SCOPES`
(`src/security/access-control.ts`), not `platform:admin`. Probe only an
instance and key you are authorized to use.

```bash
curl -s "https://<host>/v1/models" -H "Authorization: Bearer <key>"
```

Two things block a probe before any application code sees it:

- **Cloudflare 1010** — an edge rejection, not an application response.
  Matching the failing client's `user-agent` makes the probe comparable; it
  does not bypass a browser-integrity challenge.
- **401 from an edge proxy** (openresty, APISIX) — rejected before the gateway.
  It says nothing about the payload. Resolve edge auth with the instance owner
  first.

For pulling the recorded request off the instance, use
[`cartethyia-remote-debugging`](../cartethyia-remote-debugging/SKILL.md).

## Prove the flip

Unit tests and typecheck do not prove a wire change. Replay the original
failing body against an instance carrying the change and show the status change.

```bash
PORT=12801 CARTETHYIA_PUBLIC_ORIGIN=http://127.0.0.1:12801 bun run src/main.ts
curl -s -H "Authorization: Bearer <key>" http://127.0.0.1:12801/v1/models
```

Confirm the route exists first: a local deployment lacks a remote deployment's
aliases, and a 404 there is a fixture gap, not a result.

**Prove the test locks the fix:** revert the change, see the test fail, restore
it, see it pass. A test that passes both ways proves nothing.

## Hygiene

- A credential may be echoed and reused when the user explicitly asks; a
  throwaway debug credential is disposable and secret-handling ceremony must
  not block the replay. The one absolute is **git**: never in source, env
  files, commits, logs, reports, or telemetry. `AGENTS.md` "Git, data, and
  credentials" is the owner.
- **Re-state the credential in the command that uses it.** An exported shell
  variable does not survive between tool calls, so `curl` sends an empty
  `Authorization` header and returns `000` with exit 43. That looks like "host
  unreachable" and ends the investigation before the failure is reproduced.
- **Diagnose `000` before believing it.** Run `curl -v` once with no credential:
  a `401` proves the host answered and only the key was missing, while `000`
  with no response means DNS, TLS, or egress. Do not report a host as
  unreachable on a single `000`.
- **`curl -o <file>` is unreliable on Windows here**: it intermittently returns
  exit 43 / HTTP 000 even against a host that answers (schannel renegotiation),
  which is indistinguishable from the unreachable case above. For a replay that
  needs the response body, prefer `bun -e` with `fetch` — same request, no
  schannel path. If `curl` must be used, confirm with `curl -v` first.
- Work in a scratch directory outside the repo; delete it when done. Leave no
  replay scripts or captured payloads in the tree.
- Send the same `user-agent` as the failing client so the gateway takes the same
  path.
- Stop any instance you started.
- Repeated invalid model requests trip the IP strike window ("Warning n/10 … will temporarily ban this IP"). Keep probe counts low and list `/v1/models` before guessing model ids.

## Report

State the exact field that caused it, the replay table (what passed, what
failed), whether the baseline was repeatable, the layer you fixed and why it
owns it, and the before/after status against a real instance. Say plainly what
you could not verify — e.g. whether other upstreams on that wire share the
behavior, when the available routes could not exercise them.
