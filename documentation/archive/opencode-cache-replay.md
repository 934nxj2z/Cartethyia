# OpenCode cache replay

> [!WARNING]
> **Superseded (2026-10-14).** The gateway now sends a different fingerprint:
> `x-opencode-client: desktop`, a fresh `x-opencode-request` `msg_` id per
> dispatch, and a stable `ses_` session. Free-model dispatches also force
> `stream: true` and backfill the agent-tool quartet. The notes below describe
> the 2026-10-13 state and are kept as history. The current contract lives in
> `src/providers/integrations/opencode/fingerprint.ts` and
> `documentation/reference/providers.md`.

**Status:** completed, live replay. **Date:** 2026-10-13. **Source:** commit `50b57c04`.

> **Current contract:** [`opencode-free-tier.md`](./opencode-free-tier.md).
> **See also:** [opencode-freetier-replay.md](./opencode-freetier-replay.md)
> — the 2.0.29 DMG/RPM reverse-engineering and replay attempt that followed,
> including how to extract UDIF/RPM without `7z` or `hdiutil`.

## What was established

Repeated no-credential requests to `POST https://opencode.ai/zen/v1/responses`
with model `muse-spark-1.2-contributor-free` returned measurable prompt-cache
reads. For an identical 5,695-token input, the second and third requests
reported 5,617 cached tokens (98.6%). Rotating `x-opencode-session` did not
prevent the same cache hit.

A controlled toggle of `prompt_cache_key` on an otherwise identical body warmed
after the first request and then reported the same cached tokens whether the
key was present or omitted. Dropping the key did not explain the warm hit for
those prompts. This does not rule out effects for other bodies.

This shows the Free route can serve cache hits with a manually constructed
request. It does **not** show the replay matches an OpenCode macOS client: no
persistent installation id was sent, and no macOS request was captured.

## What the local CLI captures showed

Two captures of the installed OpenCode **v2.0.26** on Windows, both against a
local mock, never against the Free service:

- A custom OpenAI-compatible provider sent streamed `POST /v1/responses` with
  `store: false`, `prompt_cache_key` equal to the session id, and 12 tools.
- The built-in `opencode` provider sent `POST /zen/v1/chat/completions` with no
  `prompt_cache_key` and no `store`. That synthetic model selected Chat
  Completions, so this is not the shape used for the Free model.

Both sent `user-agent: opencode/latest/2.0.26/cli`, `x-opencode-client: cli`,
four session headers carrying the same id, and per-request `traceparent`/`b3`.
Neither sent `x-opencode-request` or an install id. Replaying the full captured
body to the Free service returned `403 FreeTierError`; a smaller synthetic body
with the same headers returned 200. The failure was not isolated to one field.

The inspected macOS artifact was OpenCode desktop 2.0.28 (DMG SHA-256
`1ABBC91E…B2A9`). Its ASAR holds the desktop shell, not the CLI, so it cannot
prove the headers the CLI emits. The macOS binary was not run.

## What changed in the gateway

The adapter now preserves a caller-provided `prompt_cache_key` on wire families
that carry it, and does not invent one where the capture had none. Chat
Completions emits `max_completion_tokens` and keeps `stream_options.include_usage`.
The fingerprint forwards `x-opencode-project` when the client supplies it and
falls back to `global` otherwise, and derives one stable `ses_` id per
conversation so the four session aliases stay equal across dispatches.

This is closer to the observed CLI, not byte-for-byte proof of the Free model
or the macOS 2.0.28 client. No live cache replay was run after the alignment.

## Limits

No paid route was tested. Body changes, tool ordering, model routing, and
backend cache state remain separate variables. A catalog or capture from one
model does not describe another: model definitions can select a different wire.

Owners: `src/providers/integrations/opencode/provider.ts`,
`fingerprint.ts`, and `test/providers/opencode-fingerprint.test.ts`.
