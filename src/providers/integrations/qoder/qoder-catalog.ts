// Qoder model catalogs, one per realm, plus the live listing that supersedes them.
//
// The two realms publish different rosters: the donor's snapshot files
// (`qoder_catalog_cn.json`, `qoder_catalog_intl.json`) disagree on 5 keys and on
// the context window of the keys they share. A single merged list therefore
// advertises models a given account cannot reach, and hides the ones only the
// other realm serves — so each realm keeps its own static floor.
//
// The static rows are the *offline floor*, not the truth: the authoritative list
// is `/algo/api/v2/model/list` for the account's own realm (`discoverQoderModels`).
import { GatewayError } from "../../../protocol/gateway-error";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { QODER_CHAT_PATH, QODER_MODELS_PATH, qoderGatewayCandidates, type QoderRealm } from "./qoder-realm";

/** One upstream catalog row, as `/algo/api/v2/model/list` reports it. */
export interface QoderCatalogEntry {
  readonly key: string;
  readonly displayName: string;
  readonly isVl: boolean;
  readonly isReasoning: boolean;
  readonly maxInputTokens: number | undefined;
  readonly enable: boolean;
}

/** One static row's shape, mirrored on `QODER_MODEL_CONFIGS` in `qoder.ts`. */
interface QoderModelConfig {
  readonly id: string;
  readonly display_name: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens?: number;
  readonly is_vl: boolean;
  readonly is_reasoning: boolean;
}

/**
 * China roster (14 keys).
 *
 * Captured from the donor's `qoder_catalog_cn.json`, which is the decoded
 * `chat` array of a real CN account's model list.
 */
export const QODER_CN_MODEL_CONFIGS: Readonly<Record<string, QoderModelConfig>> = {
  auto: { id: "auto", display_name: "Auto", max_input_tokens: 200000, is_vl: true, is_reasoning: true },
  qmodel_38max: { id: "qmodel_38max", display_name: "Qwen3.8-Max", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qfmodel: { id: "qfmodel", display_name: "Qwen3.8-Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen3.7-Max", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qmodel: { id: "qmodel", display_name: "Qwen3.7-Plus", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  q37fmodel: { id: "q37fmodel", display_name: "Qwen3.7-Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  dmodel: { id: "dmodel", display_name: "DeepSeek-V4-Pro", max_input_tokens: 96000, is_vl: true, is_reasoning: true },
  dfmodel: { id: "dfmodel", display_name: "DeepSeek-Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  gmodel: { id: "gmodel", display_name: "GLM-5.3", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  gfmodel: { id: "gfmodel", display_name: "GLM-5.3-Flash", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  gm51model: { id: "gm51model", display_name: "GLM-5.2", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi-K3", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  kmodel: { id: "kmodel", display_name: "Kimi-K2.8-Preview", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  mmodel: { id: "mmodel", display_name: "MiniMax-M2.7", max_input_tokens: 180000, is_vl: false, is_reasoning: false },
};

/**
 * Global/intl roster (17 keys), from the donor's `qoder_catalog_intl.json`.
 *
 * Note how the shared keys differ from CN — `auto` is non-reasoning here and
 * `qmodel` carries a 1M window. That is why the rosters are not merged.
 */
export const QODER_INTL_MODEL_CONFIGS: Readonly<Record<string, QoderModelConfig>> = {
  auto: { id: "auto", display_name: "Auto", max_input_tokens: 200000, is_vl: true, is_reasoning: false },
  ultimate: { id: "ultimate", display_name: "Ultimate", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  // `fast` is what the live roster reports today; `performance` is the older
  // key for the same slot. Both are kept so a hand-added model id written
  // against either name still resolves — the roster is the offline floor, and
  // discovery supersedes it on the first successful fetch.
  fast: { id: "fast", display_name: "Fast", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  performance: { id: "performance", display_name: "Performance", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  efficient: { id: "efficient", display_name: "Efficient", max_input_tokens: 200000, is_vl: true, is_reasoning: false },
  smodel: { id: "smodel", display_name: "Sonus", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  cmodel: { id: "cmodel", display_name: "Cantus", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qmodel_38max: { id: "qmodel_38max", display_name: "Qwen3.8-Max", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qfmodel: { id: "qfmodel", display_name: "Qwen3.8-Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen3.7-Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  qmodel: { id: "qmodel", display_name: "Qwen3.7-Plus", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi-K3", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  kmodel: { id: "kmodel", display_name: "Kimi-K2.8-Preview", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  gmodel: { id: "gmodel", display_name: "GLM-5.3", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  gfmodel: { id: "gfmodel", display_name: "GLM-5.3-Flash", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  dmodel: { id: "dmodel", display_name: "DeepSeek-V4-Pro", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  dfmodel: { id: "dfmodel", display_name: "DeepSeek-Flash", max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  mmodel: { id: "mmodel", display_name: "MiniMax-M3", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
};

/** Output ceiling when the upstream states none, matching `qoder.ts`. */
const DEFAULT_OUTPUT_TOKENS = 32_768;

function qoderModels(
  configs: Readonly<Record<string, QoderModelConfig>>,
  providerId: string,
): readonly ModelDefinition[] {
  return Object.entries(configs).map(([id, cfg]) =>
    defineModel({
      id,
      providerId,
      wireFamily: "chat",
      endpoint: QODER_CHAT_PATH,
      ctx: cfg.max_input_tokens,
      out: cfg.max_output_tokens ?? DEFAULT_OUTPUT_TOKENS,
      vision: cfg.is_vl,
      reasoning: cfg.is_reasoning,
    }),
  );
}

/** Static offline catalog for the China realm. */
export const QODER_CN_MODELS: readonly ModelDefinition[] = qoderModels(QODER_CN_MODEL_CONFIGS, "qodercn");

/** Static offline catalog for the global/intl realm. */
export const QODER_INTL_MODELS: readonly ModelDefinition[] = qoderModels(QODER_INTL_MODEL_CONFIGS, "qoder");

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Reads upstream's `{"chat": [...]}` envelope.
 *
 * Rows without a usable `key` are dropped rather than coerced: a model id the
 * upstream did not state would become an unroutable catalog row.
 */
export function mapQoderCatalogResponse(raw: unknown): QoderCatalogEntry[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const chat = (raw as Record<string, unknown>)["chat"];
  if (!Array.isArray(chat)) return [];
  const entries: QoderCatalogEntry[] = [];
  for (const row of chat) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const key = record["key"];
    if (typeof key !== "string" || key.trim().length === 0) continue;
    const displayName = record["display_name"];
    entries.push({
      key: key.trim(),
      displayName: typeof displayName === "string" && displayName.length > 0 ? displayName : key.trim(),
      isVl: record["is_vl"] === true,
      isReasoning: record["is_reasoning"] === true,
      maxInputTokens: positiveInt(record["max_input_tokens"]),
      // Absent means "not stated", which is not the same as disabled.
      enable: record["enable"] !== false,
    });
  }
  return entries;
}

/** Projects one live catalog row onto a Cartethyia catalog row. */
export function qoderCatalogModel(
  entry: QoderCatalogEntry,
  providerId: string,
): ModelDefinition {
  return defineModel({
    id: entry.key,
    providerId,
    wireFamily: "chat",
    endpoint: QODER_CHAT_PATH,
    // `null`, not omitted: an upstream row that stated no window is unknown,
    // not unlimited, and `defineModel` substitutes its own "unfiled" estimate
    // for null — the same marker a hand-added row gets.
    ctx: entry.maxInputTokens ?? null,
    out: DEFAULT_OUTPUT_TOKENS,
    vision: entry.isVl,
    reasoning: entry.isReasoning,
  });
}

/**
 * Header factory for one signed request.
 *
 * Injected rather than imported: the COSY signer lives in `qoder.ts`, which
 * imports this module's rosters — importing it back would be a cycle. The
 * callback receives the URL and the exact body that will be sent, because the
 * signature covers both.
 */
export type QoderSigner = (url: string, body: string) => Promise<Record<string, string>>;

/**
 * The account's own live model list.
 *
 * Two details are load-bearing and non-obvious:
 *
 * - the request is a **GET that carries the signed body**. A bare GET answers
 *   403, because the server validates signature against body; the donor
 *   (`read_dynamic_models`) signs `{}` and sends it as the GET's data.
 * - the signature covers only the path, so switching gateway hosts between
 *   attempts does not invalidate it.
 *
 * Hosts are tried primary → fallbacks (intl has three, CN one) and the first
 * host that answers with a usable list wins.
 *
 * Signing is injected, never reimplemented: `headers(url, body)` is the COSY
 * signer from `qoder.ts`, passed in because that module imports this one and
 * importing it back would be a cycle. `encode` is the same arrangement for
 * Qoder's scrambled body alphabet — omitted, the literal `{}` is both signed
 * and sent, which is what a caller whose signer already binds the credential
 * wants.
 *
 * `fetcher` is optional in the type but required at runtime, and there is
 * deliberately no global-`fetch` default: a test cannot reach the network by
 * accident, and production is forced through the SSRF-validated egress
 * (`network/outbound-fetch.ts`). That egress is a `node:http` path, which is
 * also the only way a body reaches the wire on a GET — `fetch` itself rejects
 * `GET` + `body` with "request with GET/HEAD method cannot have body".
 */
export async function discoverQoderModels(input: {
  readonly realm: QoderRealm;
  /** Account secret the injected signer signs with; blank fails fast. */
  readonly credential: string;
  readonly headers: QoderSigner;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Defaults to the realm's bundled provider id (`qodercn` | `qoder`). */
  readonly providerId?: string;
  /** Body encoder; Qoder uses its own scrambled base64 alphabet. */
  readonly encode?: (body: Uint8Array) => string;
}): Promise<readonly ModelDefinition[]> {
  const providerId = input.providerId ?? (input.realm === "cn" ? "qodercn" : "qoder");
  // The credential belongs to the caller and is never echoed into `details`;
  // this only refuses the case where discovery was asked for without one,
  // which would otherwise surface as an opaque 403 from upstream.
  if (typeof input.credential !== "string" || input.credential.trim().length === 0) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Qoder model discovery requires an account credential.",
      { providerId, realm: input.realm },
    );
  }
  const fetcher = input.fetcher;
  if (fetcher === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Qoder model discovery requires a validated outbound fetch",
      { providerId, realm: input.realm },
    );
  }
  const signedBody =
    input.encode === undefined ? "{}" : input.encode(new TextEncoder().encode("{}"));
  let lastError: unknown;
  for (const host of qoderGatewayCandidates(input.realm)) {
    const url = `${host}${QODER_MODELS_PATH}`;
    try {
      const headers = await input.headers(url, signedBody);
      const response = await fetcher(url, {
        method: "GET",
        headers: headers as unknown as HeadersInit,
        // The signed body must accompany the GET or upstream refuses it.
        body: signedBody,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!response.ok) {
        lastError = new Error(`Qoder model list answered ${response.status}`);
        continue;
      }
      const entries = mapQoderCatalogResponse((await response.json()) as unknown);
      // Emptiness is judged after `enable` filtering, not before: a roster
      // whose every row is disabled has no usable model and must fall through
      // to the next host rather than return an empty catalog.
      const enabled = entries.filter((entry) => entry.enable);
      if (enabled.length === 0) {
        lastError = new Error("Qoder model list returned no usable models");
        continue;
      }
      return enabled.map((entry) => qoderCatalogModel(entry, providerId));
    } catch (error) {
      lastError = error;
    }
  }
  throw new GatewayError(
    "transport_unavailable",
    502,
    `Qoder model discovery failed for ${input.realm}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
    { providerId, realm: input.realm },
    "upstream",
  );
}
