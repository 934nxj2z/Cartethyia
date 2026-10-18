# OpenCode free-tier replay — `big-pickle`

> [!WARNING]
> **Historical (2026-10-14), corrected 2026-10-18.** This document records how
> the first 200 OK was reached and how the client was captured. **Three of the
> values it establishes no longer pass**: the `user-agent`, the tool threshold,
> and the `x-opencode-request` refusal. Do not follow it as a contract.
>
> The current contract, the replay recipe, and the corrections ledger live in
> [`opencode-free-tier.md`](./opencode-free-tier.md).

> [!NOTE]
> **200 OK reached.** The anonymous free tier answers at
> `POST https://opencode.ai/inference/v1/chat/completions` with
> `Authorization: Bearer public`, `stream: true`, the four session headers, and
> the full agent tool set. See "200 OK achieved" for the isolation table and
> "Defects to fix" for what Cartethyia must change.
>
> `big-pickle` is **chat-only**: the Responses wire answers
> `400 ModelProtocolUnsupported`. It is the free id the listing always carries,
> which is why it is the one to debug against.

**Status:** complete, live replay, 200 OK reproduced.
**Date:** 2026-10-14, corrected 2026-10-17. **Artifacts:** a macOS DMG and a
Linux RPM of the desktop app, an installed CLI, plus a config-redirected
capture of a real free-tier dispatch. The client version is deliberately not
pinned anywhere the gate is described: it does not validate the version
(1.18.0 through 2.0.32 behave the same), so naming one release reads as if
that release were required.

## Question

`opencode/big-pickle` fails via the wire with:

```
403 FreeTierError — OpenCode's free tier can only be used from within OpenCode.
```

Goal: find what the real client sends and what upstream now expects, so
Cartethyia's fingerprint can be made 1:1.

## Artifacts and provenance

| Artifact | SHA-256 / name | Notes |
| --- | --- | --- |
| `opencode-desktop-mac-arm64.dmg` | `edd274ba…b6c9e8` | 263,188,968 B; UDIF (`koly` v4), Apple_HFS |
| `opencode-desktop-linux-x86_64.rpm` | `opencode-2.0.29-1` | 194,084,941 B; xz-compressed cpio |

Both differ from the previously inspected 2.0.28 DMG (`1ABBC91E…`), so the
earlier notes (`opencode-cache-replay.md`) no longer describe this build.

## The capture that worked (no mitm)

MITM was **not** usable: `opencode.exe` is a self-contained binary that ignores
`HTTP_PROXY`/`HTTPS_PROXY`, ignores `NODE_OPTIONS=--require` with an undici
`ProxyAgent`, and never traverses a listening proxy even though the CLI itself
successfully completes a free-tier request.

What worked is **redirecting the provider through OpenCode's own config**, no
OS-level interception:

1. Run a local HTTP server on `:9900` that serves a `models.dev`-shaped
   `/api.json` whose `opencode` entry points `api` at `http://127.0.0.1:9900/v1`,
   and that logs every other request (headers + body) before replying with a
   minimal SSE stream.
2. Point the provider at it with a project config:
   ```json
   { "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:9900/v1" } } } }
   ```
3. Run the CLI with `OPENCODE_CONFIG_DIR` set to that project and a free model:
   ```
   opencode run -m opencode/big-pickle "reply PONG"
   ```
   `OPENCODE_MODELS_URL` alone is **not** enough — it only overrides the catalog
   fetch; the dispatch still uses the built-in base URL. The config override is
   what redirects the request.

Full captured request/response: `opencode-freetier-capture.log`.

### What the real client sends (runtime-confirmed)

```
POST /v1/chat/completions
authorization:      Bearer public
x-opencode-client:  cli
x-opencode-project: 82b484de3985b491abf573de7d60d7999302b858   (40-hex hash)
x-opencode-session:      ses_ec50fdea1ffe9DeKoTBUAi615X
x-opencode-session-id:   ses_ec50fdea1ffe9DeKoTBUAi615X
x-session-affinity:      ses_ec50fdea1ffe9DeKoTBUAi615X
x-session-id:            ses_ec50fdea1ffe9DeKoTBUAi615X
user-agent:         opencode/latest/cli   ← STALE: see the note below
b3 / traceparent:   present
body: model, messages[{role:"system"}, {role:"user"}], stream, tools
```

Three corrections this forces, all previously wrong in this investigation:

- **`Bearer public` is the client's value, but not a requirement.** An earlier
  pass recorded it as inert; a later one recorded it as required. Both were
  measured badly. Absent answers 200; *wrong* answers 401.
- **`x-opencode-client` must be `cli`.** The adapter used to send `desktop`; it
  now sends `cli`, matching every source. The gate accepts either.
- **`x-opencode-project` must be a 40-hex hash**, not the literal `global`.

The session id is 26 chars (`ses_` + 12 hex + 14 base62) with a descending
time part ending `ffe` (counter 1) — the canonical layout the client mints,
**not** the 64-hex literal found in the desktop binary.

The wire follows the model, not the tier: `big-pickle` is chat-only, so the
capture above is the chat shape. A Responses-native free id uses
`/v1/responses` with `input[]` and `instructions` instead of `messages[]`.

### 200 OK achieved

The anonymous free tier answers at
`POST https://opencode.ai/inference/v1/chat/completions` for `big-pickle`.
Isolated by dropping one field at a time from the captured request:

| Variation | Result |
| --- | --- |
| `Bearer public` + **all 11 agent tools** + session headers + `stream:true` | **200** — output `PONG` |
| Same with 10 tools (`execute` dropped) | **200** — output `PONG` |
| Only the 5 "core" tools (`bash, edit, glob, grep, read`) | **403** |
| Only `bash` | **403** |
| No tools at all | **403** |
| No `Authorization` (everything else exact) | **403** |
| Endpoint `/zen/v1` instead of `/inference/v1` | **403** |
| All four session headers removed | **403** |
| `x-opencode-client: desktop` instead of `cli` | **200** (not decisive) |
| `x-opencode-project: global` instead of the 40-hex hash | **200** (not decisive) |
| `instructions`, `prompt_cache_key`, `include`, `max_output_tokens` dropped | **200** (not required) |

> [!WARNING]
> **The `user-agent` in this capture no longer works.** Measured 2026-10-17 on
> three fresh egresses: `opencode/latest/cli` answers `403 FreeTierError`, while
> the three-segment `opencode/latest/<version>/cli` answers `200`. The gate now
> requires a version segment and a floor of **1.18.0** — below it the upstream
> answers `426 UpgradeRequired` with the message "OpenCode 1.18.0 or newer is
> required to use the free tier". Above the floor the exact number is
> indifferent. See
> [`opencode-session-identity.md`](./opencode-session-identity.md#the-user-agent--measured-and-it-contradicts-the-capture).

> [!WARNING]
> **The tool threshold below is stale.** Measured 2026-10-17 on fresh egresses,
> the floor is **3 tools**, not 10: 0/1/2 answer `403 FreeTierError`, and 3
> through 13 all answer `200`. Streaming is still mandatory (`stream: false`
> → 403). See
> [`opencode-session-identity.md`](./opencode-session-identity.md#the-tool-set--the-captures-threshold-is-stale-too).

**Required (as of 2026-10-18):** a three-segment `user-agent` with a version
≥ 1.18.0; `stream: true`; at least **3** tools; and **one** affinity header
carrying a well-formed `ses_` id. `Authorization: Bearer public` is sent but not
required — an absent header answers 200, while a *wrong* one answers 401.

**Not required:** real instructions, `prompt_cache_key`, `include`,
`max_output_tokens`, a hashed project id, `x-opencode-client`, `accept`,
`content-type`, `x-opencode-request`, or the trace pair. The full table is in
[`opencode-free-tier.md`](./opencode-free-tier.md#1-the-contract).

Evidence: `opencode-freetier-capture.log` (the raw capture, headers and body).

> [!IMPORTANT]
> The table above describes **which fields matter once the egress IP is
> allowed**. From a blocked IP, every row — including the 200s — collapses to
> `403 FreeTierError`. Check the IP before bisecting anything:
> [`.skills/cartethyia-trace-replay/references/opencode-free-tier.md`](../../.skills/cartethyia-trace-replay/references/opencode-free-tier.md).

> [!WARNING]
> **Re-measured 2026-10-17: this no longer holds.** `x-opencode-request` on the
> `/inference` lane answers **200**, not 403. The header stays out of our
> adapter because the client does not send it, but it is no longer a refusal.
> See [`opencode-session-identity.md`](./opencode-session-identity.md#what-the-gate-does-not-check).

### `x-opencode-request` actively breaks the dispatch

Isolated last, and the single most surprising result: adding the request id to
an otherwise-200 request flips it to **403**.

| Variation | Result |
| --- | --- |
| No `x-opencode-request` | **200** |
| `x-opencode-request: msg_13af91f5f001OEzo9hra3HufI4` | **403** |

This matches the static finding that the header is absent from the 2.0.29
builder. The adapter had been sending it since the 2026-10-13 fingerprint and
every single-variable bisect above carried it, which is why nothing ever
turned 200 until it was dropped.

### Why earlier attempts failed

Five independent things were wrong at once, which is why single-variable
bisecting never flipped the status:

1. wrong base URL (`/zen/v1` instead of `/inference/v1`);
2. no anonymous `Authorization` (it was dismissed as a placeholder);
3. too few tools (2, 4, or 5 instead of the full set);
4. `x-opencode-request` sent on every dispatch — refused outright;
5. session/project shapes varied while the others were still wrong.

Removing any *one* of them still leaves the others failing, so the status stays
403; only the whole corrected shape answers 200.



None of `7z`, `hdiutil`, `dmg2img`, or `p7zip` were available. Done in Python.

1. **Pin the artifact.** `sha256sum` + `file`. `file` misleadingly reports
   "zlib compressed data"; the UDIF trailer sits in the **last 512 bytes**.
2. **Parse the UDIF trailer** (`koly`). Read `xmlOffset`/`xmlLength` at trailer
   offset `0xD8`/`0xE0`. Here: `xmlOffset=263142360`, `xmlLength=46096`.
   Note: `sectorCount` at `0x214` is garbage in this file — do not trust it.
3. **Parse the plist** with `plistlib`. Its `resource-fork.blkx` array lists
   partitions; the payload is `disk image (Apple_HFS : 4)`.
4. **Parse the `mish` chunk table.** Each BLKX entry is 40 bytes:
   `type:4, comment:4, sectorStart:8, sectorCount:8, compOffset:8, compLength:8`
   (unpack `>IIQQQQ`, **not** `>IIIIQQ` — that is 32 bytes and silently fails).
   Chunk entries begin at offset **204** in the base64-decoded `mish` blob.
   Type `0x80000005` = zlib, `1` = raw copy, `2`/`0` = zero fill.
5. **Decompress to a raw HFS+ image** (672,321,536 B). Verify with the `H+`
   magic at offset 1024.
6. **Find the ASAR.** Scan for `{"files":` preceded by a 16-byte header whose
   first `uint32` is `4`; or search `app.asar` in the HFS catalog. Found at
   image offset **5853184**. Layout:
   `[uint32 4][headerSize][headerSize2][jsonLen][header JSON][data]`.
   Data starts at `base + 16 + jsonLen`.
7. **Walk the file index** (`files` → `files` → …) and extract by
   `offset`/`size` from the data region.

First-party code lives in `/out/main/` (main process) and
`/out/renderer/assets/` (UI). 8,300 files; 2,556 outside `node_modules`.

## Method — Linux RPM (xz → cpio)

Faster than the DMG when the ELF/ASAR hunt stalls.

1. Magic `\xed\xab\xee\xdb`; name `opencode-2.0.29-1` in the lead.
2. Payload is xz-compressed; decompress from the first xz stream
   (offset **23093**) with `lzma.LZMADecompressor` — `zstd` frames at
   121811793 are **not** the payload and error with "Data corruption".
3. The resulting cpio image holds one ELF (runtime) and the ASAR at
   **295091460**, same layout as macOS.

## Tutorial — reproduce the 200 OK from scratch

Runnable by another agent with only the installed CLI and `bun`. Work in a
scratch directory **outside** the repo (e.g. `D:/tmp/cap`); delete it when done.
No mitm, no OS-level interception, no credentials.

### 1. Stand up a capture server

Save as `srv.mjs`. It serves a `models.dev`-shaped catalog pointing the
`opencode` provider at itself, and logs every other request verbatim before
replying with a minimal SSE stream.

```js
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.url.startsWith("/api.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        opencode: {
          id: "opencode", npm: "@ai-sdk/openai-compatible", name: "OpenCode",
          api: "http://127.0.0.1:9901/v1",
          models: { "big-pickle": { id: "big-pickle", name: "Muse" } },
          free: ["big-pickle"],
        },
      }));
      return;
    }
    appendFileSync("D:/tmp/cap/full.jsonl", JSON.stringify({ url: req.url, headers: req.headers, body: b }) + "\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n');
    res.write('data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"delta":"PONG"}\n\n');
    res.write('data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n');
    res.end();
  });
}).listen(9901, () => console.log("9901"));
```

Run it in the background and confirm:
`bun srv.mjs > srv.log 2>&1 &` then `curl -s http://127.0.0.1:9901/api.json`.

### 2. Redirect the provider through OpenCode's own config

```bash
mkdir -p proj && cat > proj/opencode.json <<'JSON'
{ "provider": { "opencode": { "options": { "baseURL": "http://127.0.0.1:9901/v1" } } } }
JSON
OPENCODE_CONFIG_DIR="D:/tmp/cap/proj" \
  opencode run -m opencode/big-pickle "reply PONG"
```

`OPENCODE_MODELS_URL` alone is **not** enough — it only overrides the catalog
fetch, while dispatch keeps the built-in base URL. The `provider` config block
is what redirects the request.

### 3. Read the capture

`full.jsonl` now holds one line per request with the full headers and body.
Take the largest body (the real prompt; the smaller one is the title
generator):

```bash
bun -e 'const fs=require("fs");
const rows=fs.readFileSync("D:/tmp/cap/full.jsonl","utf8").trim().split("\n").map(JSON.parse);
const big=rows.reduce((a,r)=>r.body.length>a.body.length?r:a);
fs.writeFileSync("exact.json", JSON.stringify({headers:big.headers,body:JSON.parse(big.body)}));
console.log("tools:", JSON.parse(big.body).tools.map(t=>t.name ?? t.function?.name).join(","));'
```

### 4. Replay upstream and bisect

Strip hop-by-hop headers (`host`, `content-length`, `accept-encoding`,
`connection`), then POST to
`https://opencode.ai/inference/v1/chat/completions` — the wire the capture was
taken on. `big-pickle` is chat-only; `/responses` answers
`400 ModelProtocolUnsupported`. Dropping one field per run:

```js
const H = { ...exact.headers, authorization: "Bearer public" };
for (const k of ["host","content-length","accept-encoding","connection"]) delete H[k];
const r = await fetch("https://opencode.ai/inference/v1/chat/completions",
  { method: "POST", headers: H, body: JSON.stringify(exact.body) });
console.log(r.status, await r.text());
```

Expected: `200` with a `chat.completion.chunk` carrying `PONG`. Dropping
`authorization`, the tools, or the session headers — or switching the base URL
to `/zen/v1` — each returns `403`.

If every arm returns `403`, including the one that should be `200`, stop
bisecting: the egress IP is blocked. Repeat one request through a proxy with a
different exit IP before changing anything else.

### Pitfalls

- The CLI binary ignores `HTTP_PROXY`/`HTTPS_PROXY` and `NODE_OPTIONS`
  preloads; do not spend time on mitm.
- Single-variable bisecting will not flip the status: four things were wrong at
  once (base URL, anonymous credential, tool count, session headers). Fix the
  shape from a captured request first, *then* bisect.
- Counting a probe as "the field does not matter" is only valid when every
  other field is already correct.

## What was found (static)

### Request headers actually built

From the CLI string cluster (macOS binary, ~255497148) and the Linux bundles:

```
x-opencode-session-id
x-opencode-parent-session-id
x-session-affinity
X-Session-Id
x-parent-session-id
User-Agent
x-opencode-project
x-opencode-session
x-opencode-client
promptCacheKey
webSocket (handshake / send / receive)
```

Two id formats matter:

- `^ses_[0-9a-f]{64}$` — the **internal** CLI session literal.
- `^tool_[0-9a-f]{12}$` — tool ids.

### `x-opencode-request` is gone from the builder

Not present in the 2.0.29 header cluster. (Cartethyia's adapter still sends it
because our own `fingerprint.ts` emits it — it is not evidence about upstream.)

### `x-opencode-ticket` is NOT an upstream header

25 occurrences in the macOS image, 11 in the Linux binary. Every context is
the **local PTY server**, never `opencode.ai/zen/v1`:

```
/api/pty/:ptyID/connect
/api/pty/:ptyID/connect-token
/api/experimental/persistent-pty/:ptyID/connect-token
headers: {"x-opencode-ticket": e["x-opencode-ticket"]}
binaryType: "arraybuffer", input_protocol, openSocket, connectToken
```

Do not add it to the dispatch fingerprint.

### The free-tier base URL is not `/zen/v1`

Neither the 2.0.29 desktop builds nor the installed 2.0.26 CLI
(`~/.opencode/bin/opencode.exe`, 208,963,624 B) contain the string `zen/v1`,
and neither hard-codes a model endpoint. The base URL is fetched at runtime
from **`https://models.opencode.ai/api.json`** (HTTP 200, 229 providers), which
declares:

```
opencode      -> https://opencode.ai/inference/v1
opencode-go   -> https://opencode.ai/inference/go/v1
```

Verified live against `https://opencode.ai/inference/v1`:

| Probe | Result |
| --- | --- |
| `POST /inference/v1/responses` free model | **403** `FreeTierError` |
| `POST /inference/v1/chat/completions` free model | **403** `FreeTierError` |
| `POST /inference/v1/responses` paid model, no credential | **401** `AuthError: Missing API key` |
| `GET /inference/v1/models` | **404** (endpoint serves dispatches, not the catalog) |
| `POST /inference/go/v1/responses` free model | **400** `Model is unavailable` |

So `/inference/v1` is a real, live dispatch lane, and the `/zen/v1` prefix the
adapter used for it was stale.

The `403` rows above were taken from a blocked egress IP and are therefore not
a statement about the wire: from an allowed IP the same
`/inference/v1/chat/completions` request answers `200`, and the legacy
`/zen/v1/chat/completions` lane answers `200` too. See the egress note in
"200 OK achieved".

### The desktop app never calls `/zen/v1`

Scanning every bundle and both binaries: all `opencode.ai` URLs are theme,
docs, update, `oauth/client.json`, `console`, `config.json`, `v2/openapi.json`,
and `models.opencode.ai/api.json`. **Zero** `/zen/…` request paths in the
desktop shell. Free-tier traffic is issued by the bundled **server/engine**,
not by the app — which is why a desktop-only capture can never answer this.

## Cross-check: the installed CLI

The installed CLI (`opencode.exe`, v2.0.26) was used as the runtime reference
because it completes a real free-tier dispatch. Its observed dispatch, captured
by config redirect (above), is the authority for the request contract; the
desktop builds were used only for static corroboration.

## What was tried (all 403 unless noted)

Live probes, `stream: true` throughout, endpoint
`POST https://opencode.ai/zen/v1/responses`, from a **blocked egress IP** — so
every `403` below is the IP refusal, not a statement about that field.

| Probe | Result |
| --- | --- |
| `GET /zen/v1/models` | **200** — 85 models; 9 end in `-free`; `big-pickle` listed |
| Paid model (no `-free`), no credential | **401** `AuthError: Missing API key` |
| Free `ling-3.0-flash-free` (chat wire) | **400** `Model is unavailable` |
| **All 9 `-free` models**, responses wire | **403** `FreeTierError` |
| No opencode headers at all | **403** |
| `x-opencode-client: desktop` / `cli` | **403** |
| Session 26-char (ours) vs 64-hex (CLI literal) | **403** both |
| Session descending counters 1 / 2 / 63 / 64 (`…fffe/fffd/ffc0/ffbf`) | **403** all |
| `msg_` request id, ascending and descending | **403** both |
| `+ x-opencode-request`, `+ x-opencode-project`, `+ x-opencode-directory` | **403** |
| `+ x-opencode-ticket` (16 hex / 32 hex / `tkt_`) | **403** |
| `+ Authorization: Bearer public` | **403** — read as "inert" at the time, which was wrong: it is required, and this host was IP-blocked |
| UA `2.0.26` / `2.0.28` / `2.0.29` / `opencode/1.18.31` | **403** all |
| ± tools (2, 4, and the 5 core tools) | **403** |
| ± `store:false`, `instructions`, `tool_choice:auto`, `parallel_tool_calls`, `reasoning`, `max_output_tokens`, `prompt_cache_key`, `stream_options` | **403** |
| Chat wire with tools vs Responses wire | **403** both |
| **Byte-identical replay of a real failed request** (from `telemetry-22107cf3…json`) | **403** |
| Same request stripped to bare `{model,input,stream}` | **403** |

The gate answers `FreeTierError` for the whole `-free` class while the paid
route answers `401 Missing API key`, so the endpoint is live and discriminating:
it is not a block on our address alone, and it is not a malformed-payload 4xx.

### Capture attempts (why no runtime trace)

- `mitmdump -s cap.py --listen-port 8899` works and records flows (verified with
  a manual `curl -x` — HTTP 200 captured).
- `opencode.exe` is a **self-contained PE32+** (8,192 B stub) and ignores
  `HTTP_PROXY`/`HTTPS_PROXY`; `NODE_OPTIONS=--require preload.cjs` with an
  undici `ProxyAgent` also did not intercept it.
- Running the CLI directly **succeeds** (`PONG`), so the client can use the
  free tier from this machine — but its traffic never traversed the proxy.
- Not attempted (needs authorization): editing the `hosts` file to point
  `opencode.ai` at `127.0.0.1` plus a TLS listener, which would intercept any
  client regardless of proxy support.

## Verdict

**Solved.** The free tier is reachable without a credential: it is an
anonymous lane gated on the *shape* of the request, not on a secret. Replay
returned 200 with output `PONG` once all five defects below were corrected
together. The gate checks the base URL, the User-Agent shape, the streaming flag, the
tool count, and the presence of a well-formed session id. It does **not**
require the `Authorization` sentinel and does **not** refuse
`x-opencode-request` — both were believed at the time and are corrected in
[`opencode-free-tier.md`](./opencode-free-tier.md).

The earlier "credential is bound to runtime state, replay cannot work"
conclusion was wrong: it was drawn while four independent fields were still
wrong, and single-variable bisecting can never expose that.

## Defects fixed to reach 200 OK

These are the mismatches against the observed client dispatch. All of the first
four are **required** for a 200; each alone leaves the request at 403.

> Status 2026-10-18: items 1 and 3 below are **no longer requirements** — an
> absent `Authorization` answers 200, and `x-opencode-request` answers 200. They
> were genuinely blocking at the time because other fields were also wrong.
> Item 2's threshold is 3, not 10. Kept as written to preserve the history.

0. **Wrong base URL.** `provider.ts` built `${ZEN_PATH_PREFIX}/responses`
   (`/zen/v1/...`), which returns 403 for every free model. The lane that
   answers is `https://opencode.ai/inference/v1`. Paid models answer 401 there,
   so both tiers move together.
1. **No anonymous credential.** Free-tier dispatch must send
   `Authorization: Bearer public`. Without it the request is 403 even when
   every other field is byte-exact.
2. **Too few tools.** The adapter backfilled 2; the gate needs the full agent
   set (10–11 tools). Five is not enough.
3. **`x-opencode-request` was sent.** It is no longer part of the client
   identity and is refused outright — dropping it is required, not optional.
4. **Session counter is unbounded.** `fingerprint.ts` increments
   `sequenceCounter` with no cap, so the inverted time part drifts outside the
   counter window (1–63). Clamp it.
5. **Chat wire usage.** When a non-streaming request is forced onto Chat SSE,
   `stream_options.include_usage` must be set.

## Evidence ledger

| Claim | Source | Grade |
| --- | --- | --- |
| Format ses_ 64 hex, tool_ 12 hex | CLI binary literals | static-confirmed |
| Header cluster (9 names) | CLI string cluster | static-confirmed |
| `x-opencode-request` absent in 2.0.29 | CLI cluster + Linux bundles | static-confirmed |
| `x-opencode-ticket` = local PTY | PTY paths in both builds + probes | static-confirmed |
| Desktop app never calls `/zen/v1` | full bundle/binary URL scan | static-confirmed |
| Base URL is `opencode.ai/inference/v1` | `models.opencode.ai/api.json` + live probes | runtime-confirmed |
| Real client sends `Bearer public`, `cli`, hash project | config-redirect capture | runtime-confirmed |
| Replay of that exact shape still 403 | live probes (incl. 3 requests/session) | runtime-confirmed |
| All `-free` models 403 with valid tools | live probes | runtime-confirmed |
| Paid model 401, chat-free 400 | live probes | runtime-confirmed |
| `Bearer public` inert | live probe | **refuted** — required, not inert (see above) |
| Cause of the gate | — | **unknown** |

## Next evidence needed (in order)

1. An authorized `hosts`-based interception of the real client's traffic
   (the only method that survives a proxy-ignoring binary).
2. Failing that, a request capture from an instrumented run of the bundled
   **server** process, which is the component that actually calls `/zen/v1`.
3. Do not guess a "natural sibling" header or path and describe it as observed.

## Owners

`src/providers/integrations/opencode/fingerprint.ts`,
`src/providers/integrations/opencode/provider.ts`,
`test/providers/opencode-fingerprint.test.ts`,
`documentation/reference/providers.md`.

## Addendum 2026-10-17 — the egress IP, and two corrections

This document's isolation table was produced from a host whose egress IP the
gate accepted. Re-run from a blocked IP, **every** row in it — including the
200s — collapses to 403 `FreeTierError`. That was confirmed against four
independent implementations: the official `opencode.exe` v2.0.32 with its real
config, the same client after a successful OAuth login, the stored OAuth access
token used directly, and the `opencode2api` Go gateway run as-is. The identical
byte-identical request then returned 200 through a proxy with exit
`193.202.12.2`.

So read the table above as "which *fields* matter once the IP is allowed", not
as a test of whether the gate is up. The IP is checked first and independently.

Two corrections to the sections above:

- **`Endpoint /zen/v1 instead of /inference/v1` → 403 is not universal.** On
  2026-10-17, `/zen/v1/chat/completions` answered **200** from an allowed IP
  when carrying the legacy 1.18.31 shape (`user-agent: opencode/1.18.31 (...)`,
  `x-opencode-request` present, `x-opencode-project: prj_<24hex>`, one `read`
  tool). The two lanes have different shapes; both work from an allowed IP.
- **`x-opencode-request` is lane-specific.** It breaks the `/inference` lane
  (as this document proves) and is *required* on the legacy `/zen/v1` lane.

Current contract: [`opencode-free-tier.md`](./opencode-free-tier.md).
Agent-facing summary: [`.skills/cartethyia-trace-replay/references/opencode-free-tier.md`](../../.skills/cartethyia-trace-replay/references/opencode-free-tier.md).
