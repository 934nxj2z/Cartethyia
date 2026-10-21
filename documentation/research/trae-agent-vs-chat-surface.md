# Trae — agent surface vs chat surface

Reverse-engineered from the installed Trae IDE (`%LOCALAPPDATA%\Programs\Trae`, v1.107.1)
and from live requests against a `userRegion=sg` account. Everything here was observed,
not inferred; the unknowns are labelled.

## Two disjoint surfaces

Trae exposes two completely different model planes, and a model id is only meaningful on
one of them. This is the single fact that decides whether a model can be served.

| surface | endpoint | transport | models |
|---|---|---|---|
| chat | `POST /api/ide/v1/llm_raw_chat` | SSE | the account's `model_list` entries |
| agent | `POST /api/ide/v1/agents/runs` | SSE | the IDE picker list |

They do not intersect. `deepseek-v4.1-flash` is in the second and absent from the first;
verified by hitting the chat endpoint with it on **every** chat host the IDE config lists:

```
core16-normal-sg.trae.ai    4023 model is unknown
core19-normal-sg.trae.ai    4023 model is unknown
core22-normal-sg.trae.ai    4023 model is unknown
api5-normal-alisg.mchost.guru 4023 model is unknown
trae-api-sg.mchost.guru     4023 model is unknown
coresg-normal.trae.ai       4023 model is unknown
core-normal.traeapi.us      4023 model is unknown
```

## The chat surface

`model_list` is `GET /api/ide/v1/model_list?type=chat` (from the page's own client,
`ModelList` in `main.*.js`). It is **per account region**, not per realm. The SG account
serves exactly nine, and the key field is `name`, not `model_name`:

```
claude3.5                 status=true  type=chat_model  multimodal=true   default=true
aws_sdk_claude37_sonnet   status=true  type=chat_model  multimodal=true
gemini-2.5-pro-preview-03-25
gemini_2.5_flash
gpt-4.1-2025-04-14
gpt-4o
deepseek-V3-0324          multimodal=false
deepseek-V3               multimodal=false
deepseek-R1               type=reasoning_model
```

Every row above was confirmed by a real completion except `claude3.5` and
`aws_sdk_claude37_sonnet`, which answer `3003 all models failed`. Those two are listed but
not usable — a roster row that cannot complete is worse than a missing one.

Frame layout from the region host (this is what the donor does *not* describe):

```
event: metadata
data: {"model":"","session_id":"…","prompt_completion_id":0,…}

event: output
data: {"response":"OK","reasoning_content":null,"tool_calls":null,…}

event: token_usage
data: {"prompt_tokens":4,"completion_tokens":1,"total_tokens":5,…}
```

Flat, not the nested `chunk.content` the donor's client uses, and usage arrives as its own
`token_usage` frame with the OpenAI spelling at the top level. The stream ends with no
`event: done`, so the terminal must be synthesised.

## The agent surface

`/api/ide/v1/agents/runs` is where the picker's models live. It accepts the request body —
it never returns `model is unknown` — and its only answer from this account was:

```
event: error
data: {"code":5003,"message":"your agent running quota limit is exceeded."}
event: done
data: {}
```

This was reproducible with an **empty body**, which means the quota gate runs before any
request validation. It is an account gate, not a shape problem: no body shape was found that
reaches model resolution, so the picker's models could not be probed here.

The field names the harness sends (from `harness.dll`, the request struct) are:
`origin`, `config_source`, `config_name`, `model_name`, `session_type`, `user_input`,
`agent_run_info`, `mcp_tool_list`, `custom_agent_list`, `reasoning_effort`, `mode_type`,
`extra_config`, `is_remote_req`, `use_fast_request`, `continue`.

## A third endpoint that looks like the agent path but is not

`POST /api/agent/v3/llm_utils_chat` is reachable and returns SSE. Its body is:

```
is_remote_req  bool
usage          string
model_name     string
request_seq    int
access_type    null        # typed idecopilot.AccessType; null is the only value that binds
function       string      # NOT an object — object is a 400
```

With `function` present it does reach model validation and answers `model is unknown` for
every model tested, including ones that work on the chat surface. So this endpoint is not a
back door to the picker's models; it resolves by `usage`/`function`, and the correct
`function` value was not found. It is recorded here so it is not re-chased.

## Where the picker's model ids come from

The ids (`deepseek-v4.1-flash`, `glm-5.2`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.5`,
`minimax-m3`, `minimax-m2.7`, `gemini-3.1-pro`, `gemini-3-flash-solo`, `gpt-5.4` … `gpt-6.1-sol`)
are **not** in the web bundle at all. They are carried by
`resources/app/modules/ai-agent/harness.dll`, alongside the agent endpoints:

```
/api/v1/chat/initialize          /api/v1/chat/start_chat
/api/v1/chat/start_resume_chat   /api/v1/chat/stop_chat
/api/v1/chat/subscribe_events
/api/agent/v3/create_agent_task  /api/agent/v3/resume_agent_task
/api/agent/v3/llm_utils_chat     /api/agent/v3/compact
```

`/api/v1/chat/*` is the harness's **local** Rust server (the log paths in the binary are
`harness/server/src/modules/chat/*.rs`), so those 404 on the remote host — they are not the
remote path. `harness.dll` also references `frontierUrl` and a `FrontierFrame` transport
(`frame_type`, `payload_type`, `seq_id`, `payload_encoding`), which is a WebSocket protocol
the IDE opens to the hub; the `frontierUrl` value is delivered by the server at runtime
(`harness/hub/module/src/handlers/config.rs`, `missing frontierUrl!`), so it is not in the
binary and was not obtained.

## What this means for the gateway

- The chat surface is implemented and working. The roster must be read from
  `model_list?type=chat` for the account's region, using the `name` field, and filtered to
  rows that actually complete.
- The picker's models need the agent surface. That is blocked on the agent quota for this
  account; once available, the request body and the `FrontierFrame` wire format are the
  two things to reconstruct, in that order.
- `domain_config` names the deployment host (`a0ai-api.byteintlapi.com`) but that host
  answers 404 for REST; the agent transport is WebSocket.
