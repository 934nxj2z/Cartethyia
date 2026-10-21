/**
 * Runnable reference for the Trae agent surface. Not part of the build; this exists so the
 * request shape in `trae-agent-vs-chat-surface.md` can be re-verified without re-deriving it.
 *
 * Needs a token file whose first line is the account JWT, second the uid, third the region
 * (`sg` or `us`). Run with:
 *
 *   bun run documentation/research/trae-agent-surface-request.ts <token-file> [config_name]
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const tokenFile = process.argv[2] ?? `${process.env.TEMP}/trae-token2.txt`;
const configName = process.argv[3] ?? "deepseek-v4.1-flash";

const [jwt, , region] = readFileSync(tokenFile, "utf8").trim().split("\n");

/**
 * Device identity is not validated by the endpoint — a derived pair works as well as the
 * IDE's own (`tt_net_config.config`). These are the real values from this machine, kept so
 * a capture can be diffed against the IDE's exactly.
 */
const deviceId = "7384815624742012432";
const machineId = "6e13bc3a78e0c6550f370808b85065ede27c4f90082bec6ec8b1f689644ccc85";

const headers: Record<string, string> = {
  "X-App-Id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  "x-plugin-channel": "icube-ai",
  "x-ide-version-code": "20260212",
  "x-ide-token": jwt,
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  "User-Agent": "TraeClient/TTNet",
  "X-Device-Cpu": "Intel",
  "X-Device-Id": deviceId,
  "X-Machine-Id": machineId,
  "X-Device-Brand": encodeURIComponent("Nitro AN515-58"),
  "X-Device-Type": "windows",
  "X-Os-Version": encodeURIComponent("Windows 11 Pro"),
  "X-Request-Id": randomUUID(),
  "x-ide-version": "3.6.0",
  "x-app-version": "3.6.0",
  "store-country-code": region,
};

/** Region matters: an SG token on the US host answers 403, same as on the chat surface. */
const host = region === "us" ? "https://core-normal.traeapi.us" : "https://coresg-normal.trae.ai";

const body = {
  function: "solo_agent",
  config_name: configName,
  config_source: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }],
  stream: true,
  Request: {},
};

const response = await fetch(`${host}/api/agent/v3/llm_utils_chat`, {
  method: "POST",
  headers,
  signal: AbortSignal.timeout(60_000),
  body: JSON.stringify(body),
});

const text = await response.text();
const upstream = (text.match(/"provider_model_name":"([^"]*)"/) ?? [])[1] ?? "-";
// Both fields, not just `response`: a reasoning config streams its thinking
// while `response` stays empty until the final frame, so reading only the
// answer reports an empty result on a model that in fact replied.
const answer = [...text.matchAll(/"response":"([^"]*)"/g)].map((m) => m[1]).join("").trim();
const reasoning = [...text.matchAll(/"reasoning_content":"([^"]*)"/g)]
    .map((m) => m[1])
    .join("")
    .trim();
const error = (text.match(/"message":"([^"]*)"/) ?? [])[1] ?? "";

console.log(`${configName}  http=${response.status}  upstream=${upstream}`);
if (answer) console.log(`answer=${JSON.stringify(answer.slice(0, 40))}`);
else if (reasoning) console.log(`answer="" (reasoning only) reasoning=${JSON.stringify(reasoning.slice(0, 40))}`);
else console.log(`error=${error}`);
