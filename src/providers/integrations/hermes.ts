import type { CanonicalRequest } from "../../protocol/canonical-model";
import type { ProviderDispatchTarget } from "../provider-contracts";
import type { ApiKeyProviderSpec } from "../configured-provider";
import { isRecord } from "../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../provider-sanitize";

const HERMES_PROVIDER_ID = "hermes" as const;

/** Portal attribution tags required by the Nous Research inference API. */
const HERMES_PORTAL_TAGS = ["product=hermes-agent", "client=hermes-client-v0.13.0"] as const;

function injectHermesTags(
  payload: Record<string, unknown>,
  _request: CanonicalRequest,
  _candidate: ProviderDispatchTarget,
): void {
  payload["tags"] = [...HERMES_PORTAL_TAGS];
}



import { defineModel } from "../provider-model-definition";
import type { ModelDefinition } from "../provider-model-definition";

/**
 * Offline fallback: the free rows as the live catalog last reported them.
 *
 * `loadModelDiscovery` supersedes this list whenever `/v1/models` answers, so
 * these numbers are only read by a fetch that failed. They are the upstream's
 * own `context_length` and `top_provider.max_completion_tokens` — the previous
 * values were a uniform `8192` output for every row, which understated every
 * one of them.
 *
 * Two ids that used to live here are gone because upstream no longer carries
 * them: `tencent/hy3:free` (absent from the catalog entirely) and
 * `upstage/solar-pro4:free` (only the billed `upstage/solar-pro4` and the free
 * `upstage/solar-mini4:free` exist).
 */
export const HERMES_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "poolside/laguna-s-2.1:free", ctx: 262144, out: 131072, reasoning: true }),
  defineModel({ id: "poolside/laguna-xs-2.1:free", ctx: 262144, out: 32768, reasoning: true }),
  defineModel({ id: "stepfun/step-3.7-flash:free", ctx: 262144, out: 256000, vision: true, reasoning: true }),
  defineModel({ id: "meituan/longcat-2.0:free", ctx: 1048756, out: 262144, reasoning: true }),
];


/**
 * Nous Research (Hermes) — chat-only, with provider-specific portal `tags`
 * injected through the spec's `prePayload` hook. The registry builds the
 * adapter via `createApiKeyAdapter`.
 */
export const HERMES_SPEC: ApiKeyProviderSpec = {
  provider_id: HERMES_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  prePayload: injectHermesTags,
};

/**
 * Hermes' `/v1/models` is OpenRouter-shaped and needs no credential.
 *
 * It lists the whole reseller catalog (426 rows when this was written) with
 * per-model pricing, while this provider is pinned for its free allowance.
 * Discovery therefore keeps only the rows priced at zero, which is what the
 * static list encoded by hand.
 *
 * Two fields the generic OpenAI-compatible reader misses:
 *
 * - `context_length` sits on the row, so the shared reader would find it, but
 *   the output cap is `top_provider.max_completion_tokens` — not
 *   `max_output_tokens`. Without reading it every row fell back to the generic
 *   64k default and advertised a window the model does not have.
 * - Input modality is `architecture.input_modalities[]`, not a `modality`
 *   string, so a vision row read as text-only.
 */
export async function discoverHermesFreeModels(options: {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" }, signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const rec = isRecord(payload) ? payload : undefined;
  const rows = rec === undefined ? undefined : boundedUpstreamArray(rec["data"]);
  if (rows === undefined) return null;

  const byId = new Map<string, ModelDefinition>();
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const id = sanitizeUpstreamLabel(entry["id"]);
    if (id === undefined) continue;
    if (!isFreePriced(entry)) continue;

    const context = boundedUpstreamNumber(entry["context_length"], { min: 1, max: 1_000_000_000 }) ?? undefined;
    const topProvider = isRecord(entry["top_provider"]) ? entry["top_provider"] : undefined;
    const output =
      boundedUpstreamNumber(topProvider?.["max_completion_tokens"], { min: 1, max: 1_000_000_000 }) ?? undefined;
    const architecture = isRecord(entry["architecture"]) ? entry["architecture"] : undefined;
    const inputs = boundedUpstreamArray(architecture?.["input_modalities"]) ?? [];
    const hasImage = inputs.includes("image");

    byId.set(id, {
      modelId: id,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      // `null` means "the row states no limit", which is not the same as a
      // guessed number: the routing ladder keeps its own fallback for that.
      contextLimit: context ?? null,
      outputLimit: output ?? null,
      modalities: { input: hasImage ? ["text", "image"] : ["text"], output: ["text"] },
      reasoning: true,
      toolCall: true,
      // The row reached this point only because both rates parse to zero.
      cost: { input: 0, output: 0, pricing_model: "pay-per-use" },
    });
  }
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Whether a row is on the free allowance.
 *
 * The catalog spells zero three ways — `"0"`, `"0.0000000000"`, and a missing
 * `pricing` block on a few rows — so the check parses instead of comparing
 * strings. A row with no pricing at all is treated as not free: this provider
 * is pinned for a free allowance, and admitting an unmeasured row would spend
 * the operator's credit.
 */
function isFreePriced(entry: Record<string, unknown>): boolean {
  const pricing = entry["pricing"];
  if (!isRecord(pricing)) return false;
  const prompt = Number(pricing["prompt"]);
  const completion = Number(pricing["completion"]);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return false;
  return prompt === 0 && completion === 0;
}
