---
name: cartethyia-provider-catalog
description: "Add, remove, import, authenticate, or curate a provider or model; refresh provider client versions and fetchers. Use for adapters, OAuth/BYOK flows, packed-catalog rows, /v1/models, capabilities, client User-Agent versions, and availability claims."
---

# Provider and catalog

Use for adding, removing, importing, authenticating, probing, or curating
providers and models.

## Add a bundled provider

1. Identify the metadata, registry, adapter, auth, catalog, and quota
   authorities.
2. Add only the provider-specific pieces required by the existing integration
   family.
3. Preserve required headers, user-agent, body shape, endpoint path, and
   streaming format.
4. Update intentional dashboard mirrors, config, docs, and `.env.example`.
5. Verify through the real composition root, not isolated stubs.

Do not invent capabilities, pricing, limits, or availability when upstream is
silent. A catalog row is not proof that a model answers.

## OAuth and account flows

Redirect URIs must exactly match the allowlist. Refresh-only, device, browser,
cookie, and imported-credential flows have different boundaries; follow the
existing family. Keep credentials server-side and redact them from logs and
payload capture.

For OAuth, verify the real browser callback, state single-use behavior,
persistence, refresh registration, and one real request through the account when
safe.

Credentials that arrive nameless — polished tokens, plain JWTs — are labelled
`<providerId>-key-N` or `<providerId>-jwt-N` by `nextGeneratedAccountLabel`
(`src/console/providers/catalog/store.ts`). Numbering is per kind and per
provider, case-insensitive against existing labels, so pasting five keys into
one provider yields `dcint-key-1 … dcint-key-5` instead of five identical
"<providerId> account" rows.

## Fetch a Buddy model catalog

CodeBuddy and WorkBuddy (including WorkBuddy CN) expose two different catalog
surfaces. Do not confuse the desktop product-config snapshot with Cartethyia's
runtime discovery:

| Purpose | International endpoint | Response shape |
|---|---|---|
| Desktop picker snapshot / manual investigation | `GET https://www.codebuddy.ai/v3/config`, `GET https://www.workbuddy.ai/v3/config`, or `GET https://www.workbuddy.cn/v3/config` | `data.agents[].models` is the picker roster; `data.models[]` has metadata |
| Cartethyia account discovery | CodeBuddy: `/v2/enterprises/personal/models`; WorkBuddy variants: `/v2/enterprises/personal/models` | `data.models[]` plus `data.agents[]`; `disabled` and the `cli` agent roster constrain the result |

WorkBuddy CN is the same WorkBuddy client contract on `www.workbuddy.cn`.
Its desktop client version is fetched from that host's
`/v2/update?platform=workbuddy-win32-x64-user` feed; keep its version source
separate from the international `.ai` feed because releases can differ.

## Refresh client versions quickly

When provider/client identity work is in scope—or while doing a quick
maintenance pass—check whether the known client versions in
`src/providers/operations/client-versions.ts` have moved. Do a bounded source
check and update verified pins; do not turn this into a broad audit or download
large installers when a small official metadata response answers the question.

| Identity | Source to check | Update |
|---|---|---|
| Claude Code CLI | `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` | `VERSION_SOURCES.claudeCli` |
| Claude Code bundled SDK | The matching `@anthropic-ai/claude-code-win32-x64` package. Fetch its `dist.tarball` only if the binary must be inspected, then find the `NT="x.y.z"` constant behind `X-Stainless-Package-Version` in `claude.exe` | `VERSION_SOURCES.claudeSdk` |
| Kiro IDE | `https://formulae.brew.sh/api/cask/kiro.json` | `VERSION_SOURCES.kiro` |
| Kiro streaming SDK | The signed Windows installer: the `@aws/codewhisperer-streaming-client` version imported by `getCodeWhispererStreamingClient` | `KIRO_RUNTIME_SDK_VERSION` |
| Kiro SSO/OIDC SDK | The same installer: the embedded `@aws-sdk/client-sso-oidc` used by the login/refresh bundle | `KIRO_SSO_SDK_VERSION` |

The CLI version and each bundled SDK version are separate identities. Do not use
the standalone `@anthropic-ai/sdk` npm latest as Claude Code's bundled version,
and do not take the first matching version string in a Kiro installer — tie it
to the active import path. For reference, Claude Code `2.1.296` bundles SDK
`0.128.0`; Kiro IDE `1.2.56` uses streaming SDK `1.0.39` and SSO SDK `3.980.0`.

After changing a pin, check any derived User-Agent/fingerprint consumers remain
connected to the same source, add or update a focused assertion in
`test/providers/client-version-monitor.test.ts`, and run that test file plus
`bun run typecheck`. Preserve separate regional client identities and fallbacks
where their official feeds differ.

The `/v3/config` result depends on the client identity in `User-Agent`. The
observed identities in
[`buddy-live-model-catalogs-2026-10-12.json`](../../data/provider-catalogs/buddy-live-model-catalogs-2026-10-12.json)
are examples from that capture, not permanent version pins:

| Product | Host | Observed `User-Agent` |
|---|---|---|
| CodeBuddy CLI | `www.codebuddy.ai` | `CLI/4.12.1.39217423 CodeBuddy/4.12.1.39217423` |
| WorkBuddy desktop | `www.workbuddy.ai` | `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2` |

When refreshing the snapshot, use a currently authorized account and the
matching current client identity. Send `Accept`, `User-Agent`, `Origin`,
`Referer`, `Authorization: Bearer <access token>`, and `X-User-Id` (the account
UID belonging to that token). The endpoint can return HTTP 200 with no usable
models for an invalid or mismatched identity; HTTP success alone is not proof
of a catalog. A generic or unrelated User-Agent may return a different shape,
an empty list, or an error.

For a one-off fetch, keep the token in `BUDDY_ACCESS_TOKEN` and the account UID
in `BUDDY_USER_ID`, never in the command or the snapshot. Send `Accept`,
`Authorization: Bearer`, `X-User-Id`, `User-Agent`, `Origin`, and `Referer` for
the matching host, then `GET /v3/config`.

Before keeping the output, check the envelope `code` is `0` and that an `agents`
entry named `cli` has a non-empty model roster. An empty roster means the
identity was wrong — do not overwrite a good snapshot with it. Save only the CLI
id roster and the model metadata (`id`, `name`, token limits, `supportsImages`,
`supportsToolCall`, `supportsReasoning`, `credits`) to
`data/provider-catalogs/buddy-live-model-catalogs-<date>.json`. Never persist
headers, tokens, the account UID, or email. CN hosts are a separate variant and
are not covered by that snapshot.
## Daily check-in coordination

Buddy accounts have three check-in paths and they must not race:

- **Queue** (`enqueueCheckin`/`dequeueCheckin` in `src/workers/daily-checkin.ts`)
  — bounded in-process queue of pending claims; a new account's claim is
  parked here instead of a second timer.
- **Sweep ride-along** (`src/workers/quota-refresh-sweep.ts`) — the sweep
  drains the queue past the usual freshness gate, so a queued claim does not
  wait for the next scheduled refresh.
- **Manual** (dashboard button → `src/console/quota/account-quota-tenant.ts`)
  — bypasses `markCheckinAttempted` on the inbound call but stamps it on the
  way out, so a manual claim still blocks the automatic paths from a second
  attempt in the same window.

## BYOK and custom providers

Derive the wire contract from the compatibility profile. Validate base URL,
model, auth, allowed wire families, and network policy at the server boundary.
Dashboard forms submit data; they do not implement auth or routing policy.

`resolveByokWireProfile` (`src/providers/operations/byok-wire-profile.ts`) is the
authority. Do not re-hardcode authentication or wire-family mappings in
registration, discovery, or connection-test paths.

A newly-created custom OpenAI-/Anthropic-compatible provider defaults to
`skipProxy: true`: `DEFAULT_PROXY_SKIP_PROVIDER_IDS` is built from the
bundled catalog, so the "not bundled" test on the create path is what
applies the default. An explicit `skipProxy` in a later patch still wins —
an operator who turned proxying back on keeps it on.

## Model catalog

- OpenCode Zen is id-oriented; models.dev carries rich metadata.
- OpenCode's **free tier** (`opencode`) has two independent failure modes,
  and they are not interchangeable:
  - **Egress IP blocked** — a 403 `FreeTierError` that survives every header
    permutation, and that the official client reproduces from the same host.
    Nothing in `provider.ts` fixes it; a datacenter IP (Railway and similar) is
    refused, so this provider needs an egress proxy. Check this first.
  - **Request shape** — the wire must carry the agent-tool fingerprint set in
    `tools`, so any change that trims, dedupes, or rewrites that array can turn
    a working dispatch into a 403 `FreeTierError`.

  The names, the trap, and the replay evidence are in
  [`cartethyia-trace-replay`](../cartethyia-trace-replay/references/opencode-free-tier.md).
  Free ids are chat-only (`responses` → 400 `ModelProtocolUnsupported`), and
  `Authorization: Bearer public` is still required.
- The offline catalog is a packed, brotli-compressed binary blob:
  `src/providers/discovery/catalog/catalog-blob.ts` (generated) +
  `catalog-format.ts` (the `PackedCatalog` reader) +
  `models-dev-catalog.ts` (the public API). It is the single offline
  authority for limits, pricing, and capability; do not add a duplicate raw or
  compact snapshot. Lookups are binary searches over typed-array columns — there
  is no JSON parse and no per-row object at boot.
- Refresh it with `bun run scripts/generate/models-catalog.ts`. Generation
  fetches models.dev for breadth and pricing plus `models.opencode.ai` for the
  OpenCode family's authoritative limits, and the server reads only the
  committed blob.
- Provider-id remaps live in `CATALOG_PROVIDER_IDS`
  (`src/providers/discovery/models-dev-catalog.ts`).
- `/v1/models` omits unavailable optional fields rather than emitting null.
- Capabilities are normalized to `text | image | audio | video | pdf` at
  emission.
- Pool capabilities and pricing are claims about every member, not one member.
- Catalog presence is not availability; use an authorized real probe.
- `WIRE_FAMILIES` (`src/protocol/canonical-model.ts`) is shared canonical
  vocabulary: `chat`, `responses`, `messages`, `gemini`. Adding a family is a
  contract change — the console's Elysia body schema and compatibility
  validator project the same tuple, and `wire_family` is a **persisted enum**,
  so it needs a forward migration in *both* `migrations/full-postgres/` and
  `migrations/lite-sqlite3/` (same filename, or
  `test/persistence/sqlite-baseline.test.ts` fails the parity check).
  - `gemini` is Factory's native generateContent wire
    (`/api/llm/g/v1/generate`, `x-api-provider: google`). It is **not**
    chat-shaped: cataloguing a Gemini id as `chat` posts it to an endpoint that
    does not serve it, which fails at the endpoint rather than at routing —
    so nothing local catches it.
  - Wire family and `SourceSurface` are **not** the same vocabulary (`gemini`
    is a wire with no surface of its own; `completion` is a surface with no
    wire). Never assign one to the other without an explicit mapping.

## Image generation

`POST /v1/images/generations` is a separate service from chat. The route is
declared in `src/transport/contracts.ts`, and `createGenerationHandler` prefers
`adapter.generateImage` over `dispatchNativeService`. Shared prompt and result
helpers live in `src/protocol/image-generation.ts`.

Do not borrow the chat turn envelope for an image request. Codex chat owns
`canonicalToCodexResponsesPayload`, `buildCodexIdentityHeaders`, turn metadata,
routing hints, and `client_metadata`. Image generation posts its own body.

| Provider | Wire |
|---|---|
| Gemini | `POST {base}/models/{model}:generateContent` with `x-goog-api-key` and `generationConfig.responseModalities: ["IMAGE"]`. Read `inlineData` through `geminiInlineImages`. |
| Antigravity | Stream `POST {base}/v1internal:streamGenerateContent?alt=sse` with the agent envelope, image system instruction, `responseModalities: ["IMAGE"]`, and the existing sandbox failover. Decode SSE with `maxEventBytes: 32 * 1024 * 1024`. |
| Codex | Stream `POST {base}/backend-api/codex/responses`. A `-image` id strips that suffix and becomes the carrier. A dedicated image id uses carrier `gpt-5.6-terra` and names itself as the tool model. Send `tools: [{ type: "image_generation", ... }]`, `tool_choice: { type: "image_generation" }`, `store: false`, and `stream: true`. |

Codex image headers are the hosted set: auth, user-agent, `originator`,
`version`, `[OI]-Beta: responses=experimental`, `session_id`,
`conversation_id`, account id, and residency. Do not send the chat turn headers.

A catalog row is not an entitlement. Replay the provider directly before
changing the body: `gpt-image-*` can be rejected for a ChatGPT account, forcing
the image tool can still return `tool_choice must be specified with tools`,
leaving it optional can return 200 and ignore it, and a plain chat request
returns text. A missing `api.model.images.request` scope or a 404 is an account
boundary, not a payload bug.

Prove an image by decoded magic bytes: `89 50 4E 47` for PNG or `FF D8 FF` for
JPEG. `content_signature` and a text reply are not images, and those rejection
examples are account-specific, not guarantees. After a catalog edit, restart;
`bun --hot` keeps a cached adapter and `dist/cartethyia.exe` keeps answering on
`:12800`.

## Grok video generation

Unverified research notes, not a supported integration. The checked-in adapter
targets Grok Build at `cli-chat-proxy.grok.com` and does not implement this, so
re-probe before relying on it. The observed surface was
`POST https://console.x.ai/v1/videos/generations` returning a `request_id`, then
`GET /v1/videos/<request_id>` for `video.url`. Model `grok-imagine-video`,
duration 1–15 seconds, one `image.url` as HTTPS or `data:`, never bare base64.
The reported auth was an SSO cookie plus DPoP, not the stored OAuth token, and
the reported quota was about two videos then HTTP 429 — neither is verified. A
200 chat response is not a video; check the MP4 bytes for the `ftyp` box.

## Remove a provider

Use the [provider-removal skill](../cartethyia-provider-removal/SKILL.md). It
owns the cutover and persisted-row cleanup. Boot retires unbundled global rows;
the catalog also hides any orphan immediately and lets tenant delete remove
it without exposing a current builtin to deletion.

## Verify

The gate list is the
[engineering verification reference](../cartethyia-engineering/references/verification.md);
run those, plus `bun run test:backend`.

The boundary specific to this skill is upstream: exercise the real auth,
catalog, and request boundaries when safe. If credentials or upstream access are
unavailable, say so instead of claiming availability.
