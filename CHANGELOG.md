# Changelog

All notable changes to Cartethyia are recorded here. Entries are written for the
operator who reads them, not for the contributor who wrote the diff: what
changed, and what it means for an install. Migration numbers refer to files
that shipped at the time of the change. A fresh database builds from the
current baseline; an existing one applies the numbered files that followed it.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.4.5] — 2026-10-18

### Fixed

- **Update prints the command instead of failing with EBUSY.** An in-process
  `npm install --global` can never succeed: the process running the install is
  itself executing out of the package directory npm has to rename, and on
  Windows that rename fails with `EBUSY` and npm exits `14`. Stopping the
  gateway was not enough, because the CLI and the tray still run from that
  directory.

  Update now stops everything and prints the command to run, which is what
  9router does:

  ```text
  Update available: 2.4.4 → 2.4.5

  Run this now that Cartethyia has stopped:

     npm install --global cartethyia@latest --prefer-online
  ```

  `cartethyia update` behaves the same way. `npmUpdate()` is deleted: it could
  only ever fail, and reporting its exit code as "update finished" is what made
  a failed install look successful.

## [2.4.4] — 2026-10-18

### Fixed

- **An update now actually takes effect.** `npm install --global` cannot replace
  the package directory while a process is running out of it: on Windows the
  rename fails with `EBUSY` and npm exits `14`. The update ran with the gateway
  and the menu still alive, so the install failed and the failure was reported
  as success — "Update to 2.4.3 installs now", with the install left on 2.4.2.
  Both the menu and the tray now stop the gateway before the install and start
  it again afterwards, and a non-zero npm exit is reported with its code and
  the current version is restored rather than leaving nothing running.

## [2.4.3] — 2026-10-18

### Fixed

- **The tray no longer leaves an empty console window.** On Windows the tray
  was a Node process holding a `systray2` helper, and Windows Terminal kept a
  tab open for it for the tray's whole lifetime. That window belongs to the
  terminal, not to the process — `MainWindowHandle` reads 0, so it cannot be
  found and hidden from inside, and neither `windowsHide` nor
  `detached: true` removes it.

  The tray is now platform-specific (`scripts/cli/tray.ts`): on Windows it is a
  PowerShell `NotifyIcon` (`scripts/cli/tray.ps1`) driven over JSON lines on
  stdin/stdout, started with `-WindowStyle Hidden` so it owns no console at
  all. macOS and Linux keep `systray2`, which attaches no console there. This
  is the arrangement 9router uses.

### Changed

- `scripts/cli/cli.ts` drops the `systray2` dependency from its tray path, and
  the tray helpers that existed only to launch and stop a Node tray process
  (`waitForTrayStartupSignal`, `launchUpdatedTray`, `waitForTray`, `stopTray`)
  are gone.

## [2.4.2] — 2026-10-18

### Fixed

- **"Hide to tray" now actually runs the gateway in the background.** The handoff
  was handing a live gateway to a tray that adopted it, which meant the tray
  owned nothing and the port was empty after choosing it. It now follows the
  same shape as 9router: spawn a detached `tray` process that starts and owns
  the gateway from scratch, then drain this one so the new process can claim the
  port. The tray is a normal first-class run rather than an adopted orphan, so
  Exit, update, and `cartethyia stop` all behave the same whether the gateway
  was started from the menu or from `carte --tray`. The adoption path is gone.

## [2.4.1] — 2026-10-18

### Fixed

- **`carte` on a fresh install runs setup instead of crashing.** With no config
  file, the menu booted the gateway immediately and the operator got a stack
  trace about `CARTETHYIA_DB_MODE` being required — naming an environment
  variable, not "you have not set this up". It now detects a missing config (or
  a config with no database mode) and runs setup first, then starts.
  `cartethyia start` still requires setup to have run, because it is the
  foreground server command, not the entry point.

## [2.4.0] — 2026-10-18

### Added

- **`cartethyia stop` stops a gateway this shell did not start.** The drain
  token was regenerated on every start and `runtime.json` was deleted on
  shutdown, so the token `stop` read could never match the gateway actually
  running — it reported "no gateway found" or a 401 against a live process.
  The token is now created once per install and kept, so the menu, the tray,
  and `start` all authenticate with the same secret. `stop` also waits for the
  port to stop answering before reporting success; a 202 is not a stop.
- **Backup writes a file, not a settings page.** `POST /admin/export-backup`
  writes a gzipped config backup to the download directory. The dashboard
  export requires the console password, which is exactly what a locked-out
  operator does not have; this route is gated by loopback plus the install
  token instead. It exports the `config` section only — `telemetry_events`,
  `telemetry_usage_totals`, and `telemetry_payloads` are per-request history,
  are the bulk of the file, and are not what an operator is recovering.
  Restore stays a console action.
- **`POST /admin/reset-console-account`** deletes every console user, which puts
  `requiresSetup()` back to true so `/console` asks for a new account. A
  forgotten password previously had no recovery: `/change-password` needs the
  current password and first-boot setup only runs when no user exists. Gated
  by loopback, a constant-time token, and the literal body
  `{"confirm":"RESET"}`. Providers, API keys, and routing are untouched.
- **`carte` opens an arrow-key menu.** It lists Open Console, Reset console
  password, Backup, Visit repository, the update row, Hide to tray, and Exit.
  Built on `enquirer`, so it works over SSH and headless with no desktop
  environment.

### Changed

- The gateway runs detached with its output in `gateway.log`, so the menu owns
  the terminal instead of competing with startup logging.
- The tray's three version rows collapse into one that carries the running
  version and either "up to date" or "update to X".
- `scripts/cli/cli.ts` splits by responsibility into `menu.ts` (key capture and
  confirmations), `runtime-state.ts` (the install token), `version.ts`, and
  `wordmark.ts` (the ANSI banner). `scripts/media.ts` moves to
  `scripts/operations/media.ts`. `bun run test --scope scripts` covers the CLI.

### Fixed

- **The gateway dies with the menu.** Ctrl-C used to leave it running, so the
  next `carte` reported "already running on port 12800". The gateway was
  spawned detached and unref'd, and `kill()` from an exit handler does not stop
  a detached child on Windows — measured: the call ran and the gateway kept
  serving. It is now a child in this process group, so Ctrl-C reaches it
  directly and `process.on("exit")` covers a closed terminal or a crash.
  "Hide to tray" still hands it over untouched.
- **An adopted tray's Exit stops the gateway.** "Hide to tray" hands the
  running gateway to a tray that adopts it, so the tray holds no child process
  and Exit only closed the icon, leaving the gateway listening. It now drains
  through the loopback endpoint.
- Starting while a gateway is already running reported "stopped before
  becoming ready (exit code 1)", naming neither the port nor the cause. It now
  says the gateway is already running on that port and how to resolve it.
- The wordmark repeated down the terminal because the header was printed
  inside the menu loop while `enquirer` redraws its frame per keypress.
- A start failure printed "Cartethyia failed to start:" with an empty message.
  It now names the exit code and the usual cause.

## [2.3.4] — 2026-10-18

### Fixed

- The **menu now receives Enter.** `carte` rendered its menu but never got a
  second keypress: the gateway was spawned with `stdin: "inherit"`, so it held
  the descriptor and swallowed everything after the first key. The gateway
  does not read stdin and the menu is the only consumer, so it now spawns
  with `stdin: "ignore"`. Arrow keys move the selection and Enter chooses.

### Changed

- `scripts/cli/cli.ts` (794 lines) is split by responsibility: `menu.ts`
  owns key capture, `runtime-state.ts` owns the `runtime.json` drain token,
  and `version.ts` owns the installed/published version and `npm update`.
  No command or flag changes.
- `scripts/media.ts` moves to `scripts/operations/media.ts`, beside the other
  provider-facing operations. Run it as `bun run scripts/operations/media.ts`.
- `scripts/how-to-gen-media.md` is deleted; nothing referenced it.
- `bun run test --scope scripts` is a new scope covering `test/scripts/`. It
  pins the three CLI behaviours that regressed in 2.3.x: the non-interactive
  menu guard, the drain-token round-trip, and a corrupt state file reading as
  "no background gateway".

## [2.3.3] — 2026-10-18

### Added

- `cartethyia stop` stops a gateway left running by the menu's **Hide to
  background**. That process is not a child of the stopping shell, so it
  cannot be signalled directly: the drain token is written to `runtime.json`
  in the config directory (mode `0600`, outside `.env` because it authorises a
  shutdown) when the menu detaches, and `stop` posts it to the loopback
  `/admin/drain` endpoint. The file is removed once the drain is accepted, so
  a stale token never outlives its gateway. Without it `stop` reports that no
  background gateway was found instead of guessing at a process.

### Fixed

- "Hide to background" no longer prints a command that did not exist. It
  previously told the operator to run `cartethyia stop`, which was never
  implemented — the only way to stop a hidden gateway was to find the process
  by hand.

## [2.3.2] — 2026-10-18

### Added

- `carte` now opens an arrow-key menu instead of going straight to a
  system-tray icon: Open Console, Settings, Hide to background, Check for
  updates, and Exit. It is built on stdin raw mode, so it adds no menu
  dependency and works over SSH, on a headless box, and on Windows where the
  tray icon lands in the hidden-icons overflow and is never seen.
  `carte --tray` still starts the icon for anyone who prefers it.

### Fixed

- `carte --tray` releases the launching terminal. The Node launcher used to
  stay alive after the gateway was ready, which kept the shell open; it now
  exits once the console URL has been shown. On Windows the child is spawned
  through `cmd /c start "" /b` so it gets its own console group and closing
  the terminal no longer signals the gateway.

## [2.3.1] — 2026-10-18

### Fixed

- `ws` is bumped to `8.22.0`. The pinned `8.18.3` carried two advisories —
  uninitialized memory disclosure and memory exhaustion from tiny fragments —
  and npm reported no fix because the dependency was exact-pinned. Only
  `src/network/pool/resolver.ts` imports it, for the proxy-pool egress probe.
- Installing the package locally no longer reads as a broken install. The
  commands live in `./node_modules/.bin/`, which is not on `PATH`, so
  `cartethyia` and `carte` did not resolve after `npm install cartethyia`.
  The install instructions now say `--global` is required, name `npx
  cartethyia` as the local-install path, and point Linux and macOS users at
  npm's EACCES guidance for a global install that needs `sudo`.

## [2.3.0] — 2026-10-18

### Added

- Usage now includes average routing/preparation delay and period-bound P50,
  P95, and P99 request latency in its summary cards.
- Buddy accounts now report **real** credit usage: per-day and per-model
  deductions read from the billing meter's usage-detail endpoint and stored, so
  the Quota page shows what the upstream actually deducted instead of only the
  synthetic activity events the gateway reports itself.
- Six optional Buddy growth tasks — streak makeup, milestone redeem, streak
  lottery, cat travel, first-buddy adoption, and the trial/gift/compensation
  claims — one per upstream capability. Each is switchable individually with
  `CARTETHYIA_DISABLED_TASKS`, claimed at most once per account per day, and
  never allowed to mark an account unhealthy.
- A Buddy request that arrives without a cache key now gets one that is
  isolated per account (`wb2a-<uid>-<hash>`). The same conversation id on two
  pooled accounts used to produce the same key, so one account's prefix cache
  could be reused — and billed — against another's. A key the client supplied
  is kept.
- `POST /admin/tasks/{name}/run` triggers one scheduled task immediately. It
  uses the same loopback-and-token gate as the drain endpoint, answers 202
  once the run has started, and 409 when that task is already running.
- `bun run probe:egress` asks a provider whether it will serve a given egress,
  from a list of proxies, from a file, or from stdin. It sends the provider's
  own dispatch through the same validated fetch and pool agent the gateway
  uses, because a neutral canary cannot answer the question: a refused OpenCode
  address still answers its model listing with 200. See
  `documentation/archive/opencode-egress-probing.md`.
- A provider's Routing Strategy card has **Max inflight / proxy**: how many
  concurrent requests one proxy pool may carry *for that provider*. It is a
  third ceiling beside the per-account one and the pool's own capacity, not a
  replacement for either, so a pool can be busy with other providers while this
  one still has its own share. Default is unlimited, which keeps no counter and
  costs nothing until an operator sets a value. Migration `0010` adds the
  column.


### Changed

- Newly issued personal API keys use `carte_` followed by 12 random characters;
- A fresh database builds from the current baseline. An existing database
  applies the numbered files that followed it, recorded in
  `cartethyia_schema_migrations`. A ledger that names a retired file is
  rejected: recreate the database and recover through backup/restore, which
  maps retired routing and pool fields into the current schema.
- A chat turn is dispatched once, to the route its model selects. The gateway
  no longer executes a model-emitted `web_search` call against a configured
  search provider: a hosted search declaration is forwarded to the upstream
  that owns it, and `POST /v1/search` on a `websearch` catalog row is the only
  way to run a search.
- The offline model catalog is a packed, brotli-compressed binary blob
  (`src/providers/discovery/catalog/catalog-blob.ts`, built by
  `scripts/generate/models-catalog.ts`) instead of the `base-models.json` plus
  `scripts/generate/models-dev-snapshot.ts` pair, both now removed. Boot cost
  drops from parsing 8090 JSON rows into live objects to one brotli decompress
  (~3 ms) and typed-array views: ~140 KB of source where the JSON was 969 KB,
  with no per-row object until a row is asked for.
- OpenCode's fetched free models now publish the upstream's real limits. The
  dispatch listing (`/zen/v1/models`) carries no limits, so absent rows used to
  be published with an invented 200k/64k; the catalog now takes them from
  `models.opencode.ai` (e.g. `ling-3.1-flash-free` 262144/32768, `exo-free`
  1048576/131072). Editing an auto-fetched model on a bundled provider also
  works, where it previously answered `Model not found`.
- An OpenCode free-tier (`opencode`) dispatch is refused with 403
  `FreeTierError` when the **egress IP** is blocked, and no request change
  helps: the official 2.0.32 client, its stored OAuth token, and a third-party
  gateway all reproduce the same refusal from an affected host, while the
  byte-identical request answers 200 through a proxy. A datacenter egress is
  refused, so this provider needs an egress proxy rather than a header fix. The
  request contract itself is unchanged: `Authorization: Bearer public`, the
  11-tool agent set, and `stream: true`.

### Fixed

- The OpenCode archive is reorganised around one canonical document,
  `documentation/archive/opencode-free-tier.md`: the measured contract, the two
  failures that look identical (shape vs egress), a runnable replay recipe, a
  dated timeline, a corrections ledger of every claim this investigation got
  wrong, and what is still open. The other documents are now marked as history
  or method and link to it, and their stale values are corrected in place.
- The OpenCode dispatch identity now sends `x-opencode-client: cli`, matching the
  captured 2.x dispatch, the local 2.0.26 CLI captures and the reference
  gateway. It previously sent `desktop` on the strength of a code comment that
  no source in the archive supports. The gate accepts both, so this was never a
  refusal — it was the adapter claiming a client identity it does not have.
- The OpenCode gate's minimum header set is measured: **`user-agent` plus one
  of `x-opencode-session`, `x-session-affinity`, or `x-session-id`**. Every other
  header — including `authorization` — is individually droppable without a
  refusal, but `x-opencode-session-id` alone does not satisfy the check, and the
  session value must be a well-formed `ses_` id (`not-a-session` and empty both
  answer 403). We keep sending the client's full set; the finding is about which
  header a change must not drop.
- More of the OpenCode gate is measured, mostly as things it does **not**
  check: prompt size, 20-turn history, a system turn, `temperature`, `top_p`, a
  missing token cap, absent or malformed trace headers, and `x-opencode-request`
  all answer 200. `/zen/v1` answers `429 FreeUsageLimitError` rather than the 403
  the capture records — the lane is alive and rate-limited. Volume is not the
  trigger either: 12 sequential and 8 concurrent dispatches through fresh
  proxies all answered 200.
- The OpenCode free-tier tool threshold is measured at **3**, not the 10–11 the
  archived capture recorded: 0/1/2 tools answer `403`, and 3 through 13 all
  answer `200`. Streaming remains mandatory (`stream: false` → 403). We still
  send the client's full 13 — the lower floor is a fact about the gate, not a
  reason to send less.
- OpenCode's free-tier User-Agent rule is measured: the gate requires
  `opencode/<channel>/<version>/cli` with a **version segment** and a floor of
  **1.18.0**. `opencode/latest/cli` — the value the archived capture records —
  now answers `403 FreeTierError`, and anything below the floor answers
  `426 UpgradeRequired` with the upstream's own explanation. Above the floor the
  exact number is indifferent (1.18.0 through 99.99.99 all pass). Our adapter
  already sends the three-segment form; the capture document now carries a
  warning so nobody follows it into a 403.
- The OpenCode free-tier refusal was measured against five fresh egresses: the
  session counter window is **1–63** (64 and above answer `403 FreeTierError`),
  the 64-hex internal session literal is refused, and `x-opencode-client`,
  the session-id/affinity split, and three project-header shapes all pass. The
  refusal therefore follows the egress address, not the request. Recorded in
  `documentation/archive/opencode-session-identity.md`.
- `x-opencode-project` is sent as 40 hex, hashed from the project identity, in
  the shape the 2.x client emits. The literal `global` was a value that passed
  one probe, not the client's own shape, and the gate fingerprints this header
  beside the session id.
- OpenCode session ids are capped at the counter window the free-tier gate
  accepts. The client's own generator lets the counter grow without bound, so a
  burst of more than 63 dispatches inside one millisecond produced ids outside
  the accepted window — and a pool produces exactly that burst. On overflow the
  timestamp advances one millisecond instead. The bundle trace, the generator,
  and what is still unverified are recorded in
  `documentation/archive/opencode-session-identity.md`.
- The model probe now sends the same request shape a real dispatch does:
  `stream_options.include_usage` is attached, the sampling temperature is no
  longer pinned, and the output allowance is sentence-sized instead of 1024.
  The probe's whole purpose is to predict what live traffic will do, and it was
  a different request — which is how a provider could reject the share page with
  `400 request illegal` while accepting the probe.
- A quota fetch that failed for this sweep no longer raises a `Quota
  unreachable` pill on the account row. The account routes fine — only its
  allowance is unknown, and the next sweep retries. A real refusal
  (`quota_exhausted`) still shows, because it does not clear on its own.
- The Usage request list's reported-model toggle now reads **Show reported** /
  **Hide reported**, matching the mask toggle beside it instead of naming a
  state.
- `muse-spark-1.2-contributor-free` is back in the OpenCode free catalog on the
  Responses wire. It was dropped as deprecated, but it answers `200` with the
  agent tool set; the `403 FreeTierError` it returns without tools is the
  free-tier gate judging the request shape, not the model. Its sibling
  `muse-spark-1.3-contributor-free` is genuinely retired (`410 ModelDeprecated`)
  and stays out.
- The model an upstream reports in its own response is now recorded separately
  from the one the request asked for (migration `0012`, `telemetry_events.reported_model`).
  A provider that answers a `muse-spark` request as `deepseek-v4.1-flash` is
  telling the operator something the request cannot, and the two values were
  previously conflated. The probe toast shows it under a cog beside the sample,
  and Usage shows it on a third line behind a **Reported** toggle that defaults
  off. Taken verbatim — no prefix stripping, no comparison — and absent when the
  response named no model.
- Testing a pool against OpenCode now **enforces** its verdict: a `blocked`
  answer retires that egress for the provider, so the next dispatch skips it,
  and any other answer clears a previous block so a replaced proxy returns to
  rotation without a separate button. Before this the verdict was recorded and
  the pool stayed in rotation, which is why a pool could read `OpenCode blocked`
  and still receive traffic.
- A provider probe verdict is stored on the pool row (`network_pools.provider_probe_*`,
  migration `0011`) instead of in the operator's browser. It used to live in
  `localStorage`, which made it decorative: another machine saw nothing, the
  gateway saw nothing, and admission kept routing through a pool the badge
  called blocked. The row records the endpoint the verdict was measured
  against, so re-pointing a pool reports "never probed" rather than a colour
  about an address that no longer exists.
- The Proxy Pool tester no longer answers a question nobody asked. A probe
  verdict is keyed to the endpoint it was measured on, so re-pointing a pool at
  a new proxy drops the old verdict instead of showing `OpenCode blocked` for an
  address that is gone. The edit form tests the endpoint **being typed** rather
  than the saved one. And the probe timeout rises from 20 s to 45 s: four
  concurrent probes measured 16.7 s on a healthy egress, which left a working
  proxy intermittently reported as `unreachable`.
- An OpenCode probe no longer reports a usable egress as `unreachable`. The
  probe sent an empty `messages` array, on the theory that the IP gate runs
  before the body is read; it does not. A healthy address answered
  `400 messages must not be empty`, and every non-2xx that was not the
  free-tier refusal was mapped to `unreachable` — so four proxies that serve a
  real dispatch were shown as "OpenCode unreachable", blaming them for the
  probe's own request. The probe now sends one short turn, and any 4xx from the
  upstream's own validation reads as accepted. A spent rate is reported as
  `throttled` rather than lumped in with failures.

- A request no longer ends on the first refused proxy. `opencode` is
  credential-less, so its route plan holds a single candidate carrying every
  eligible pool, and pool selection happens inside one attempt. The attempt
  loop judged "this is the last candidate" as terminal, which was true on the
  first failure — so a 403 `FreeTierError` flagged the egress and then failed
  the request while a healthy pool sat in the same candidate. A failure the
  pool caused now retries the same candidate against a different pool.
- When every pool is refused, the answer is `503 proxy_pool_blocked` and says
  the upstream refuses them, instead of a cooldown message asking the operator
  to wait for a timer that never fires. Pool exhaustion and a provider's own
  per-proxy share now answer `proxy_pool_capacity_exceeded` and
  `proxy_pool_provider_capacity_exceeded` respectively, so the fix each one
  needs is named.

- An existing database now receives the unique index the bundled model seed
  upserts on. A database created before that index existed died at boot with
  `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`
  and never listened. Migration `0008` adds it; a fresh baseline already has
  it, so the statement is a no-op there.
- A second GitHub Copilot account now adds a row. The device dialog polled
  faster than GitHub allows, so the approval never produced a token, and the
  login lookup sent Copilot headers to `api.github.com/user`, which answers
  400. Without a login every account shared one label and the next login
  replaced the row it should have added.
- An OpenCode dispatch carrying more than 128 tool definitions is clamped
  before it is sent. Definitions the conversation already called are kept;
  the rest fill the remaining slots. Upstream refuses the unclamped list.
- A payload capture now keeps the Buddy conversation and tracing headers the
  channel check reads, so a `conversation id missing` refusal can be told
  apart from a header that was never sent.
- Tool arguments that are not strict JSON are repaired before the client
  parses them. Copilot streams a raw control character or a trailing comma;
  the client used to report the failed parse as a missing tool.
- The console log reads a request across the full width, leads with a status
  badge, and keeps the newest line at the top. Nothing is truncated, and a
  request that has not finished yet no longer prints a row of dots.

- `POST /v1/messages/count_tokens` now answers for any routed model. A route
  with no Anthropic Messages row (a combo of chat-family providers, for
  example) used to fail with `capability_unsupported`, which left Claude Code
  unable to decide whether a context still fit. Those models now get a local
  estimate — characters ÷ 4 with a flat reserve per image, counting `system`,
  tool rounds, and `tools` — the same basis the reference gateways use. A
  Messages route still forwards the count, so the provider's own number wins.
- A Buddy rejection that is about the request, not the account, no longer cools
  the account down. `11148` (broken tool sequence), `11135` (unreadable image),
  `11133` (a parameter the model rejected), `11101` (a body that failed to
  parse), `12153` (a dead session), and `14017` (trial not yet activated) are
  deterministic for that body, so parking the credential only burned a healthy
  account on a request that fails the same way everywhere else.
- A quoted `11128` in an outbound Buddy message is rewritten to `11-128`. The
  upstream blocks any request whose body contains that exact digit run — it is
  the code of the block itself — so a client that pasted the error was refused
  again for mentioning it.
- The proactive token refresh now includes accounts that are cooling down.
  Their token still expires while they are parked, and a refresh that lands
  during the cooldown is what lets them serve the moment it ends. Disabled
  accounts stay excluded.
- Buddy model discovery drops completion, NES, and codewise rows, rows whose
  declared output is 256 tokens or less, and `text-to-image` rows. Listing them
  offered a chat route that only answers 400.
- A Buddy request carrying more than 16 images keeps the first 16 and replaces
  the rest with a note, instead of sending a body the upstream rejects outright.
- The gateway refuses a 65th concurrent `/v1` request with 503 and a
  three-second retry hint. Per-key and per-tenant caps still apply; this is the
  process-wide ceiling they do not provide.
- Log lines written on a telemetry failure are scrubbed of bearer tokens, JWTs,
  provider key prefixes, and inline base64 images before they are written.
  Captured request bodies are unchanged — those stay verbatim so a failure can
  still be read.
- A Buddy `max_tokens` above the model's catalog output limit is clamped down
  to that limit, the same way an unsupported effort is clamped to the nearest
  level the ladder serves. Both are repaired at the gateway rather than
  refused: the client asked for an answer, and the gateway is the side that
  knows the limit. A model with no measured ladder is left alone.

- A Buddy account with no device token in its auth state falls back to the
  file the desktop client writes (`CARTETHYIA_DEVICE_TOKEN_FILE`, default
  `/app/data/device_token`). The read is cached for five minutes and a file
  larger than 1 KB is ignored. A missing file is the normal case and sends no
  header.


- Streaming tool calls now retain the upstream completion event, so completed
  tool-call turns end with `tool_calls` instead of a synthetic stream error.
- PostgreSQL and SQLite baselines now include provider account identity
  enrichment fields. Databases created from an older baseline are rejected
  instead of repeatedly failing the enrichment sweep.
- SQLite and PostgreSQL baselines now include alias and combo ordering columns,
  so first-boot routing lists load successfully.
- Backup restore now maps legacy ciphertext with the active encryption key,
  skips rows for retired providers with a warning, and includes the current
  model-combo ordering column in both database baselines.
- A stored background is shown by default unless it was explicitly hidden.
- Alibaba Coding Plan is grouped with well-known API-key providers, and its
  import-only credential action is labeled "Add API key" rather than OAuth.
- The Usage page no longer reports an unreceived in-flight snapshot as zero.
- Proxy imports work on Lite databases by restoring network-pool health and
  accounting columns omitted by the SQLite transport migration.
- CodeBuddy CN requests are clamped against the CN effort ladder instead of the
  international one. The realm was never threaded through, so a level the CN
  backend serves (`max` on DeepSeek V4.1 Flash, `medium` on GLM 5.1) was
  silently downgraded to what the international backend accepts. CN-only model
  ids also get an output limit now, so a raised effort no longer answers inside
  a budget sized for the lower one.
- A model the upstream does not serve stops being redialed: Buddy business code
  `11102` (and the `service info not found` / `model ... not supported` wordings)
  now cools just that (account, model) pair, escalating 6h → 24h per repeated
  report and resetting after a success. The account stays routable for every
  other model.
- `auto` and `default-model` resolve to one upstream model instead of being two
  independent rows, so two clients naming the same backend model no longer get
  separate routing and cooldown keys.
- Database suites no longer fail on a machine with no test database, and
  `CARTETHYIA_DB_MODE` is restored rather than deleted by the dialect tests —
  the deletion leaked into other files sharing the worker and made them fail
  with "CARTETHYIA_DB_MODE is required".
- Buddy chat requests now send the conversation and tracing header family the
  upstream's channel check reads: `X-Conversation-Request-ID` (the turn-level
  aggregation key the reference marks mandatory), `X-Conversation-Message-ID`,
  `X-Root-Request-ID`, `X-Trace-ID`, and the B3 trace headers. Without them the
  upstream answered `400 · 11128 "conversation id missing"` and refused the call
  as not sent from an official client.
- The gateway endpoint on the Overview page uses the origin the dashboard is
  actually served from. It was rewritten to the gateway's default port, so any
  deployment listening on another port or behind a TLS-terminating proxy
  advertised an endpoint that did not answer.
- A request now records **why** its telemetry drawer is empty. The four payload
  panels read blank whether capture is switched off, the tenant is missing, the
  attempt was not the terminal one, the capture-preference read failed, or the
  storage write failed — so an operator debugging remotely, without access to the
  server's logs, could not tell "capture is off" from "capture is broken". The
  reason is in `payloadCaptureState` on the request row and in the request-list
  and request-detail responses.
- The Quota page no longer refreshes accounts by itself. It loads once and then
  only on an explicit refresh: the page used to poll (every 2s while accounts
  were warming, every 60s otherwise) and to enqueue a refresh for every account
  whose cached value had aged out, so a single page open hit every provider's
  quota endpoint at once. The periodic sweep already keeps quota warm; the page
  is a viewer, not a second scheduler.
- "Test all" now runs three accounts at a time instead of all of them at once.
  Firing every account simultaneously is a burst the provider's own quota
  endpoint rate-limits, which failed accounts that pass individually.

## 2.2 Zhezhi

Released 2026-10-12.

### Added

**Providers**

- 28 providers added, in three auth shapes.
- **API key, live discovery.** `groq`, `together`, `deepinfra`, `siliconflow`,
  `siliconflow-cn`, `novita`, `venice`, `nanogpt`, `baseten`, `synthetic`,
  `stepfun`, `sakana`, `helmcode`, `coralbricks`, `aiand`, `wafer-serverless`,
  `qianfan`, `coreweave`, `qwen-portal`, `zhipu-coding-plan`, `umans`,
  `minimax`, `minimax-code`, `minimax-code-cn`, `firepass`. Each lists its
  models from the provider's own `/v1/models` rather than a restated catalog,
  with limits and pricing resolved from the bundled `base-models.json` rows.
- **OAuth.** `factory` signs in with the WorkOS device-code grant and
  keeps a real refresher — the access token expires with its JWT, and the
  organization claim that Factory requires on every call travels with it.
  `cloudflareai` and `alibabacp` take a pasted credential
  instead: the gateway needs the account and gateway slugs that form its base
  URL, and the Alibaba plan needs the region that selects which of two hosts
  serves it. Neither has a refresh grant, so neither registers a refresher.
- Static model rosters for `factory` (59), `cloudflareai` (11), and `alibabacp`
  (21). None of the three publishes a model-listing endpoint this gateway can
  call — Factory's roster is client-side and narrowed per account, Cloudflare's
  lives behind the account slugs in its URL, and the plan key lists nothing — so
  the catalog is the list. Context and output come from the bundled
  `base-models.json` rows; capability is declared per row, never inferred.
- Provider-specific wire rules that are not a bare bearer: `coreweave` sends the
  `OpenAI-Project` header from account state, `qwen-portal` coalesces multiple
  system messages into one (the portal answers 500 otherwise), `minimax*` and
  `umans` serve Anthropic Messages rather than OpenAI chat, and `firepass`
  carries a Kimi context cap.
- The dashboard's **Fetch models** control now appears for any provider that
  registers a discovery resolver, instead of only for custom ones. A bundled
  provider with no resolver still shows no button; nothing that worked before
  changes.
- Three routing defaults change for every provider that has no routing row.
  Max inflight is unlimited rather than 5, so a provider an operator never
  configured is no longer capped — and the rejections that produced read as
  `capacity_exhausted`, a capacity claim about a limit nobody set. A ceiling an
  operator did set still holds. A bare API key with no client identity of its
  own now identifies as the Claude Code CLI (`claude-cli/<version> (external,
  cli)`, on the live version) instead of a frozen Codex literal, which named a
  different vendor's client on requests that mostly reached neither upstream.
  Cline continues to skip the proxy by default, unchanged.
- Model sync no longer needs a stored account. A usable one is used when there
  is one; the fetch is attempted either way, and a provider that does require
  auth answers 401 itself. Previously the gate answered a local 409 — "Model sync
  needs a usable account first" — which blocked most providers, since they
  publish their model list without auth.
- `gpt-6-luna` joins the CodeBuddy and WorkBuddy rosters at the shared 1,050,000
  context window. Both read one shared list, so the row reaches each site at its
  own endpoint path. CodeBuddy CN keeps its separate roster and is unchanged.
- `dashscope` (Alibaba DashScope, mainland) on `coding.dashscope.aliyuncs.com`,
  a bearer key distinct from the Token Plan. Eight models ship as a static
  floor; `/v1/models` discovery adds whatever the plan currently serves.

**CLI and system tray**

- The package installs globally as `cartethyia` and `carte`. `cartethyia setup`
  still runs the configuration wizard; `carte` starts Cartethyia in the system
  tray instead of a foreground terminal.
- The tray menu carries the running version, a link to the repository, a version
  tracker that reads the npm registry, and entries for the Console, a password
  reset, and backup/restore — both of which open Console Settings, so neither
  action duplicates a flow the Console already owns. Exit drains the gateway
  through the authenticated `POST /admin/drain` route and waits for in-flight
  requests instead of killing the process.
- Choosing the update entry installs `cartethyia@latest` through npm and relaunches
  the tray, confirming readiness over a one-shot signal file before the old
  process exits. An install that fails restarts the current version instead of
  leaving the operator with nothing running.
- Tray launches detach and hide their window, so no console stays attached
  behind the tray icon; the launching terminal prints `Loading Cartethyia…` and
  the URL once `/health` reports ready.

**Media generation**

- `POST /v1/images/generations` is a separate service from chat, with its own
  dispatch path and body envelope. Chat turn headers, turn metadata, and routing
  hints are not sent on it.
- Provider-owned image wires: Gemini asks `:generateContent` for `IMAGE` and
  reads `inlineData`; Antigravity streams its agent envelope and reads
  `inlineData`; Codex sends a Responses `image_generation` tool on a dedicated
  image path and decodes streamed frames.
- A video generation route is mounted, and a custom provider can declare image
  or video as a service kind.
- Buddy image models are served by CodeBuddy and WorkBuddy only.
- CodeBuddy image generation now uses its native image endpoint; WorkBuddy
  retains its chat-carried image path. Model Lab exposes image/video generation
  controls, including size and count selection where supported, and keeps media
  placeholders visible while generation is in progress.
- `scripts/operations/media.ts` provides reusable CodeBuddy image/video commands, including
  automatic video task polling by default and `--no-wait` for returning a task
  ID.
- Buddy image generation has been verified; Buddy-family video generation has
  **not** succeeded end to end. The `/v2/videos/generations` submission path is
  configured, but the actual task polling endpoint remains unknown. The
  current sibling poll URL is an unverified inference, not a confirmed provider
  contract.

**Providers**

- Web-session providers (Claude Web, Grok Web, Kimi Web) use pasted sessions and
  static catalogs. Grok accepts only `bash`, `readFile`, `webSearch`, and
  `browsePage`; Kimi accepts no function tools.
- The provider list gains collapsible sections, and custom providers render in
  their own section again.
- Direct egress resolves through the OS resolver, so a pool on a VPN is not
  misclassified as a dead proxy.

**Web search**

- Declaring a web-search tool no longer affects chat route selection or request
  shaping. The gateway resolves a configured fallback provider only after the
  selected model emits a `web_search` function call, then continues the model
  turn with the result. The direct `POST /v1/search` API is unchanged.
- Web-search capability is a property of the provider rather than a column on the
  model row and is consulted only when resolving a tool invocation, not when
  planning a chat request.
- Hosted search tools are translated per wire instead of forwarded verbatim —
  Codex receives `{"type":"web_search"}`, an OpenAI wire receives
  `web_search_preview`, and a bare `web_search` declaration on
  `/v1/chat/completions` is recognized rather than dropped.
- The provider-detail "Test search" control reports the probe's latency, result
  count, and normalized hits (or the upstream error) instead of a pass/fail line.

**Console**

- A batch account import is one round-trip instead of one per account.
- Backup export writes compressed raw connections.
- The dashboard adds a privacy mode that masks proxy and account values, and the
  quota controls get their own panel.

**Durability**

- A schema change must land in both migration sets. Every file in
  `migrations/full-postgres/` needs a same-named file in
  `migrations/lite-sqlite3/`, and `test/persistence/sqlite-baseline.test.ts`
  fails when one is missing — the parity check previously compared `0000` only, so
  a forward migration could ship for PostgreSQL and never reach an existing SQLite
  database.

### Changed

- `scripts/` is grouped by purpose rather than by mixed role: `cli/` (the global
  commands, launchers, setup wizard, and doctor), `operations/` (start, restart,
  health sweeps), `install/` (the host-level shell installer), `build/`, `generate/`,
  `dev/`, `test/`, and `shared/`. `scripts/ci-run-tests.ts` is now
  `scripts/test/run.ts`, `scripts/install-lite.sh` is `scripts/install/lite.sh`,
  and `scripts/internal/env.ts` is `scripts/shared/env.ts`. No script changed
  behavior; only its path did.
- The release build sequence moved out of a chained `package.json` string into
  `scripts/build/build.ts`, which names each step and stops at the first failure
  instead of relying on `&&`.
- The npm package description is now a full paragraph naming the proxy, both
  protocols, and the delivery engine behind the endpoint, instead of a single
  line.
- Documentation no longer embeds a copy of the Lite installer.
  `documentation/installation.md` links the canonical
  `scripts/install/lite.sh` and describes what it does; the inlined copy had
  already drifted from the script it claimed to reproduce.

- A fresh profile's glass is retuned so cards read as glass over the page
  background while the chrome framing them stays lighter. Cards ship clarity 45 /
  blur 20 (an 11px backdrop blur), sidebar and topbar clarity 25 / blur 10
  (7.5px) — was 70/5 and 67/67, which made the chrome the blurriest surface on
  screen. Existing saved profiles keep their own values; only the default moved.
- DeepSeek now dispatches on its Anthropic Messages wire
  (`https://api.deepseek.com/anthropic` + `/v1/messages`, `x-api-key`) instead of
  the OpenAI chat wire. The `/v1/models` OpenAI-compatible discovery still reads
  from the provider's bare host, so the two surfaces stay separate. The Anthropic
  adapter takes an explicit provider id so the registry's identity check and the
  provider-keyed quirks resolve against DeepSeek, not the Anthropic builtin.
- The dashboard stylesheet cutover is complete. `console.css`, `landing.css`, and
  `share.css` are gone; the tree is `tokens.css` (tokens), `base.css`
  (reset/elements), and `app.css` (the irreducible set plus the shell frame). One
  dialect styles every surface: token → utility → primitive. The type scale is
  role-named (`micro`/`badge`/`caption`/`body`/`body-lg`/`lead`/`title`/`display`/
  `hero`) at a 2px spacing step, and radii, shadows, stacking, and named viewport
  breakpoints are tokens rather than literals. All 464 static inline styles are
  gone, and 462 arbitrary literal utilities are down to 79, both held by a
  ratchet that no file may exceed (`dashboard/style-guard.json`).
- The tinted inline banner is now one block, `components/patterns/banner.tsx`,
  instead of six call sites each writing its own `color-mix(in srgb, …)`. The
  tint is `.banner` in `app.css`, keyed by `data-tone`, so a tone change is one
  rule and a fourth tone is one selector. The alphas had already drifted per
  site — 40% line / 8% wash against 45% on the setup chips — which is what a
  per-site decision looks like once nothing holds it together. Callers pass
  `surface="raised"` when the banner sits on a card, so the translucent wash
  cannot composite against the card's own colour. The setup chips, which fill
  with `surface-2` rather than washing, take a `--color-warning-line` token
  instead of the block; rendering is unchanged there.
- `Model Lab` is the Studio surface: the old playground is retired from both the
  console and the dashboard (`0011_drop_studio_sessions.sql`), and routed models
  are chatable.
- Buddy protocol, cache, quota, and tool recovery are aligned across the
  CodeBuddy, CodeBuddy CN, and WorkBuddy variants.
- Stop-reason mapping is consolidated per wire family.
- The default gateway API key is identified by a new `is_default` column
  (`0004_api_keys_is_default.sql`) rather than by its label, so renaming cannot
  break the Studio lookup, and a partial unique index rejects a second live
  default per tenant. The migration promotes a key seeded by an earlier build.
- Docker Compose reads its bundled Redis address from `CARTETHYIA_REDIS_URL`, so a
  host-oriented `REDIS_URL=redis://localhost:6379` in `.env` cannot enter the
  container. PostgreSQL remains external.
- Invalid-model IP bans use a 30-minute sliding window: ten hits inside it ban the
  address for 6 hours. A valid request no longer resets the count.
- Payload frames are gzipped at the write, and the storage check widens to the new
  encoding; a frame written before this stays readable.
- Documentation is split into `reference/` (indexes, one page per layer) and
  `features/` (narrative per feature), with the entry pages at the root.
- The agent guide names `agent-browser` as the mandatory tool for UI verification
  and consolidates the gate list into one owner.

### Removed

- The pasted web-session providers `claude-web`, `grok-web`, and `kimi-web`, with
  the `shared/web-session` module only they used. `mimodesktop` and `mimostudio`
  are the remaining signed-in-session providers and now share the console's
  "Web Session Providers" section on their own.

- The console command palette: its `⌘K` shortcut, its topbar button, and the
  component behind them. The sidebar is the navigation surface.

### Fixed

**Providers**

- A rejected credential now says what the operator can actually do. `Re-login
  required` was rendered for every `auth_invalidated` account, which is only
  true of an OAuth one; a BYOK API key has no login to return to, and the row
  sent the operator after a sign-in button their provider does not have. An API
  key now reads `Replace API key`.
- A declared endpoint path is no longer rewritten against the provider's base
  URL. The strip existed so `https://api.openai.com/v1` plus
  `/v1/chat/completions` would not join into `/v1/v1/chat/completions`, and it
  hid the fact that 13 bundled providers declared exactly that doubled path. The
  specs now declare the path below the version root they actually sit under, so
  a wrong path reaches the operator as the wrong URL instead of being quietly
  corrected into a different address.


**Providers**

- `deepseek-flash` joins the DeepSeek catalog. Like the other V4 flash rows it
  takes image parts, unlike `deepseek-v4-pro` which stays text-only; all three
  resolve 1M context and 384k output from the base catalog.
- OpenRouter ships its `:free` tier as a default catalog and fetches it live.
  A committed list is only a snapshot — OpenRouter rotates the tier within days —
  so discovery filters the provider's own listing down to the `:free` rows and
  marks each one a free-tier row, the same shape the OpenCode Zen free fetch
  uses. `apodex/apodex-1.1-mini:free` is the one live `:free` model left out of
  the committed list, because the base catalog has no pricing row for it under
  any provider and a guessed number would read as a measurement.
- The Mistral catalog drops `mistral-small-latest` and both Magistral rows.
  Mistral's own model overview deprecates Magistral Medium and Small in favour
  of Mistral Medium 3.5 and Mistral Small 4, so listing them advertised models
  the provider is actively retiring.
- Antigravity serves `claude-opus-5-5` and `claude-sonnet-5-5` at 1M context
  and 128k output, the same figures the Claude integration carries. The output
  cap they actually enforce on Antigravity's own host is unverified: the 4.6
  rows are pinned at 64000 because that host was observed rejecting anything
  higher, and no 5.5 request has been captured, so a matching ceiling would
  need its own wire-profile entry rather than a catalog row.
- Kilo Code joins the console's "Free Limited Providers" section alongside Cline.
  Both resell the OpenRouter catalog, so their free allowances are metered
  against one upstream.

**Web search**

- The keyless Parallel route no longer depends on one response shape. The public
  MCP answers a `tools/call` with the same payload twice — once in
  `result.structuredContent`, once JSON-encoded in the text block at
  `result.content[0].text`. Only the first was read, so an upstream that drops it
  turned every credential-free search into a 200 with zero results and no error.
  The text block is now the fallback, and a non-JSON block (a rate-limit notice,
  a refusal) reads as an empty result set rather than a failed request.

**Console**

- Two controls that carried only the `btn*` marker classes rendered with no
  styling at all, because those names exist for tests and one container query
  and nothing in the stylesheet paints them: the credential notice's external
  "Sign in" link and the add-account dialog's "Import file" label. The button
  atom's recipe is now exported and composed by both.
- A provider whose identity is fixed shows a real disabled dropdown. The
  hand-built stand-in carried the select's marker class without the utilities
  the real trigger owns, so the value and its chevron stacked as loose text.
- The routing slider is sized to sit beside the text inputs in its row rather
  than tower over them (20px track, 12px thumb).
- "Paste" and "Import file" moved out of the credential textarea's row to their
  own line, right-aligned. Sharing the row took ~120px from the textarea and
  left the actions floating beside a six-row input.
- Backup export, restore, and delete-all focus the console password field when
  the dialog opens. The field asked for React `autoFocus`, which fires once at
  mount and is then overridden by the modal focus hook — the hook reads
  `[data-autofocus]`, and no caller had used it, so the dialog opened focused on
  the panel instead of the one field all three flows require.
- Disabled models leave their origin group and collect under their own
  "Disabled models" section at the end of the list. Source and enabled state are
  separate axes — a built-in row can be disabled and a fetched one can be too —
  so a group the operator has mostly switched off no longer fills the top of the
  list with entries that cannot be routed.
- Every provider now carries a "Fetch models" button, including one that
  publishes no model-listing endpoint. The button used to be hidden for those,
  which left the operator with no way to find out why their provider listed
  nothing. Syncing one now names the actual reason: add an account first when
  there is no credential, and a "no listing endpoint" message when a credential
  exists and the catalog is the compiled one. A fetch that genuinely found
  nothing is still reported as a successful zero, which is a different thing.
- Gemini serves `POST /v1/search`. It already grounded through Google Search,
  but every Gemini model was registered as an ordinary chat row, so the search
  route had no resolvable target and the Search tab listed nothing. The two
  grounding models — `gemini-2.5-flash`, the adapter's own fallback, and
  `gemini-3-flash-preview` — are registered on the websearch service kind under
  their real names, at the per-model `:generateContent` path grounding posts to.
- A provider with no account is no longer skipped when the compiled catalog is
  seeded. It shipped with no models at all until an account was added, and the
  orphan prune in the same walk never ran for it, so a row left behind by an
  older catalog survived forever. That is what left the `gemini-search` alias
  in the catalog with a route pointing at a model id nobody serves; it is gone.
- The Add Custom Provider dialog's two switches move to the right edge of their
  rows. They were sitting in the row body, left of the label.
- The console no longer abbreviates OpenAI as `[OI]` in any label or in-code
  reference. The one remaining spelling is a literal upstream header name, which
  is a wire value rather than a label.

**Packaging**

- The root manifest version was `2.2.0` while the dashboard manifest carried
  `2.2`, so the version guard failed and the Console and tray header disagreed
  with the published package. The root is now `2.2`.

**Gateway**

- A pasted full endpoint in a BYOK Base URL no longer breaks discovery. The model
  list was derived from the whole pasted path, so
  `https://api.deepseek.com/anthropic/v1/messages` discovered at
  `…/anthropic/v1/messages/models` (404). The endpoint tail is now stripped and the
  root is used, the connection test says what it corrected, and the dashboard form
  shows the root to save. The wire derivation is unchanged — a `messages` base still
  reads `x-api-key`.
- `search:invoke` is now revocable. It was implicitly re-granted on every read, so
  no key could hold `routing:invoke` without search.
- A context-window overflow reported only in prose is classified as
  `context_length_exceeded` (413) instead of a generic `400`, and is retryable — an
  overflow is a property of the chosen route's window, so failover tries a sibling
  on a larger window verbatim. Only exhausting the candidates returns the 413.
- A reseller suffix on a model id (`:free`, `@variant`) no longer hides its limits.
  Stripped provider-scoped first, so OpenRouter's own row still wins.
- A mistyped Redis IP-abuse key is deleted and the request is recounted; a live ban
  or limit still applies. Redis being unreachable remains a 503.
- Buddy credit exhaustion is a hard `quota_exhausted` cooldown for 12 hours, and a
  buddy-family channel rejection (`400 · 11128`) parks the account for 6 hours
  instead of leaving it in rotation. The existing sweep restores both.
- Inline `<think>` tags split across SSE chunks stay one reasoning span across
  chat, completion, Responses, and Messages.
- A plain-HTTP `CARTETHYIA_PUBLIC_ORIGIN` keeps the console session cookie
  non-Secure even when the production binary has `NODE_ENV` baked in.
- A regional model rejection now cools the account; a proxy VPN hang is recorded as
  such.
- The buddy family keeps its variant's fixed leading system prompt — replacing it
  with the caller's system text made every request fail as an unapproved channel.

**Console and dashboard**

- The default gateway API key renames. A later clause had dropped `label` from the
  PATCH exactly when an `isDefault` key was given a different name, so the update
  reached the store with an empty `set(...)`.
- The Usage page counts cached tokens, not whole requests — a request with any
  cache hit had its entire input counted as cached.
- Account rows, proxy masking, the usage headline, and the quota panel are
  tightened; nested cards stay clear and proxy tables stay consistent.
- Active OAuth and JWT account badges are distinguished.
- Model Lab turns stay readable after reload.
- System health is restored and the background toggle behaves.
- A late import, `tailwind-merge`, dropped a role font size when a colour utility sat
  beside it — `cn("text-badge", "text-text-secondary")` silently emitted only the
  colour.

**Removed**

- `scripts/commands/grok-health-sweep.ts`, an unreferenced operator tool that
  probed Grok accounts one by one for the `407` exhaustion signal. Nothing ran it
  and nothing imported it. The 407 probe itself is unchanged —
  `src/providers/discovery/probe-phases.ts` and its coverage in
  `test/providers/grok-feature-probe.test.ts` remain — so the gateway reads Grok
  exhaustion exactly as before.
- The Cursor and Devin providers, with their adapters, OAuth clients, quota
  collectors, discovery, catalog metadata, and dashboard icons. On the next boot
  each unowned `providers` row is retired and its builtin model rows cascade away;
  telemetry history is untouched.
- The Studio playground surface and its sessions table.
- Verified dead exports: `getCachedQuota`, `resetBackgroundQuotaRefreshesForTests`,
  `resetSweepLogMemory`, `setPoolForTesting`, `isToleratedMissingExtension`,
  `byteLength`, `groupEvents`, `installIdPath`, `DEFAULT_PROVIDER_ROTATE_COUNT`, and
  the `ApiKey` type that duplicated `apiKeys.$inferSelect`.

### Migration notes

- `0004_api_keys_is_default.sql` — the default gateway API key is identified by a
  column, not its label. An install keeps its existing key; a second live default
  per tenant is rejected.
- `0005_payload_jsonl_storage.sql` — widens the payload-frame storage check to accept
  gzipped frames. On SQLite the table is rebuilt and its rows kept.
- `0010_account_identity_enrichment.sql` — adds the account identity a batch import
  now returns in one round-trip.
- `0011_drop_studio_sessions.sql` — drops the retired Studio sessions table.
- `0013_default_provider_user_agent.sql` — the route-identity column default
  becomes the Claude Code CLI identity, and rows still holding the retired
  frozen default are converted. A row with exactly that value cannot be
  distinguished from an operator who deliberately picked Codex, so only that
  one string is rewritten; any other stored identity is untouched.

Each has a same-named SQLite twin under `migrations/lite-sqlite3/`.