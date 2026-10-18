---
name: cartethyia-remote-debugging
description: "Pull failing requests off a live Cartethyia instance and replay them: console endpoints to find the record, how to authenticate, how to export a verbatim payload, and how to replay it against the same instance. Use when the bug is on a remote deployment you cannot read from disk."
---

# Remote debugging a live instance

Use when the failure is on a deployment you do not have filesystem access to —
a Railway/Render/VPS gateway, a shared staging box — and you need the actual
failing request before you can fix anything.

This skill is about **getting the evidence out of the instance**. Once you have
a verbatim payload, hand off to `cartethyia-trace-replay` for the bisect. Do not
bisect on a guess; do not bisect on a payload you retyped.

## The two surfaces, and which one to use

| Surface | Auth | Use for |
|---|---|---|
| `/v1/*` | tenant API key (`CARTETHYIA_API_KEY`) | Replaying requests, confirming behaviour |
| `/console/api/*` | console session | Listing and exporting recorded requests |

The console prefix is `/console/api` — it is mounted in
`src/console/console-router.ts` (`new Elysia({ prefix: "/console/api" })`) and
hard-coded in `console-router-guards.ts`. A probe against `/api/...` returns
`404`, which is easy to misread as "the endpoint does not exist here".

The gateway route and the console route are different auth domains. A key that
works on `/v1/chat/completions` will not read `/system/usage/requests`. If the
console needs a browser session, the dashboard's own "Export"/download path is
the way in, not `curl`.

## Credentials

- A credential for a throwaway debug environment is disposable and may be
  echoed and reused when the user explicitly asks. The one absolute is **git**:
  never in source, env files, commits, logs, or telemetry. `AGENTS.md`
  "Git, data, and credentials" is the owner.
- **Re-state the credential in the command that uses it.** An exported shell
  variable does not survive between tool calls; `curl` then sends an empty
  header and returns `000` with exit 43, which reads as "host unreachable" and
  can end the investigation before the failure is reproduced.

## Diagnose `000` before believing it

`000` is ambiguous — DNS, TLS, egress, or a missing credential all look the
same. Run `curl -v` once and read the status line:

- `401` — the host answered; only the credential was missing or wrong.
- `404` — the host answered; the **route** is wrong, not the host.
- `000` with no response — DNS, TLS, or egress. Only now is the host genuinely
  unreachable.

An unauthenticated probe returning `401` is the cheapest way to tell these
apart. Do not report a host as unreachable on a single `000`.

## Step 1 — prove the instance answers

```bash
BASE="https://<host>/v1"
curl -s "$BASE/models" -H "Authorization: Bearer <key>"
```

The model list is ground truth for what the instance can route. A model id that
resolves locally but is absent here is a fixture gap, not a routing bug — and it
is the usual explanation for a `404` on a model name.

## Step 2 — find the failing request

Console endpoints (`src/console/observability/routes.ts`):

- `GET /system/usage/requests?period=…&limit=…&status=…` — the list the Usage
  page reads; filter by the HTTP status you are chasing.
- `GET /system/usage/requests/:requestId` — one record, with the error envelope.
- `GET /system/usage/requests/:requestId/download` — **the whole payload**. This
  is the one that matters: it gives the exact bytes to replay, so you never
  retype a body.

Read `error.details` before theorising. `providerCode`, `providerStatus`, and
`raw` carry what the public `message` drops; `param` is often empty even when
the upstream knows exactly which field it rejected.

## Step 3 — replay verbatim

Send the exported body unchanged, with the failing client's `user-agent` so the
gateway takes the same path. Repeat it two or three times: a single 4xx may be
transient, and a baseline that does not repeat is not a baseline.

Then go to `cartethyia-trace-replay` for the bisect — remove one thing at a time
until it turns 200, and prove the flip after fixing.

## Triage by status

| Status | Usual owner |
|---|---|
| `404` | Model id absent from `/v1/models`; alias or combo resolved to a name the provider does not serve |
| `400` | A payload field, not the model — bisect the body |
| `401`/`403` | Key or scope, not the payload — **but see the egress rule below first** |
| `429` | Rate limit; lower probe counts |
| `503` | No healthy account upstream, or admission found no route |
| `504` | Upstream timeout, not a payload bug |

Repeated invalid model requests trip the IP strike window ("Warning n/10 … will
temporarily ban this IP"). Keep probe counts low and list `/v1/models` before
guessing ids.

### When a 403 survives every payload change, vary the egress IP

A 403 that is identical across every header, body, and credential permutation
is usually not a request bug — it is an IP-level block. Before spending another
round on the payload:

1. Run the **vendor's own client** from the same host. If it also fails, the
   contract is not yours to satisfy.
2. Repeat the byte-identical request through a proxy with a different exit IP.
   A 200 there and a 403 direct proves the block is on egress.

Confirmed against OpenCode's free tier on 2026-10-17: 403 direct, 200 through a
proxy, with the request unchanged. A datacenter egress was refused outright, so
the provider needed an egress proxy rather than a header fix. Details:
[`cartethyia-trace-replay` → `references/opencode-free-tier.md`](../cartethyia-trace-replay/references/opencode-free-tier.md).

## Hygiene

- Work in a scratch directory **outside the repo**; delete it when done. Leave
  no replay scripts or captured payloads in the tree.
- Payloads contain user content and credentials-in-flight. Do not paste a whole
  captured body into chat, a commit, or a report — extract only the fields under
  investigation.
- Stop any instance you started.
- Probe only an instance and key you are authorized to use.

## Report

State the host, which endpoint produced the evidence, the request id, the status
before and after, and the field you attributed it to. Say plainly what you could
not verify — for example, when the instance exposes only a subset of providers
and other upstreams on the same wire could behave differently.
