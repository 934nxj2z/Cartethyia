import type { ModelDefinition } from "../provider-model-definition";
import { isRecord } from "../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../provider-sanitize";
import { modelsDevCatalog } from "./models-dev-catalog";
import { isResponsesNativeModelId } from "../provider-model-definition";
interface FetchModelsOptions {
  readonly baseUrl: string;
  /**
   * Canonical provider id for this discovery run. Passed through to the base
   * catalog so a model's context/output limits and pricing come from the row
   * for the provider actually serving it; omitting it opts into the
   * unambiguous-bare lookup, which fails closed when the catalog disagrees.
   */
  readonly providerId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/**
 * Tolerant OpenAI-compatible `/models` fetcher — provider-specific
 * `src/providers/discovery/openai-model-discovery.ts`. Handles `data|models|items`, various
 * pricing/context shapes, and responses wire family detection.
 */
export async function fetchOpenAICompatibleModels(
  options: FetchModelsOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    const response = await fetcher(url, {
      headers: {
        ...(options.headers ?? {}),
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = extractEntries(payload);
    if (entries === null) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      const id = sanitizeUpstreamLabel(entry.id);
      if (id === undefined) continue;
      const fallback = modelsDevCatalog.resolve(options.providerId ?? "", id);
      const parsedContext =
        positiveNumber(entry.context_length) ??
        positiveNumber((entry as Record<string, unknown>).input_token_limit) ??
        positiveNumber(entry.contextWindow) ??
        positiveNumber(entry.max_input_tokens) ??
        modalityContextLimit(entry);
      const contextWindow = parsedContext ?? fallback?.contextLimit ?? 200_000;

      const parsedOutput =
        positiveNumber(entry.max_output_tokens) ??
        positiveNumber((entry as Record<string, unknown>).max_output_tokens) ??
        positiveNumber(entry.maxTokens) ??
        modalityOutputLimit(entry);
      const maxOutputTokens = parsedOutput ?? fallback?.outputLimit ?? 64_192;
      const outputTokens = Math.min(maxOutputTokens, contextWindow);

      const cost = modelsDevCatalog.costFor(options.providerId ?? "", id);

      // Capability comes from the upstream's own `modality` field, never from
      // the base catalog: that lookup is keyed by bare model id and keeps only
      // the first provider row, so it would attribute a stranger's capabilities
      // to this gateway's serving. An undeclared capability is left to the
      // routing ladder's filter → degrade path.
      const rawModality = typeof entry.modality === "string" ? entry.modality : "";
      // Same reason it never comes from the base catalog: capability is what
      // the upstream declares for the model it serves. A catalog that declares
      // it as an `input_modalities[]` array instead of a `modality` string was
      // read as text-only, so a vision model lost image input.
      const hasImage = rawModality.includes("image") || modalityImageInput(entry);
      const responsesWire = isResponsesNativeModelId(id);
      byId.set(id, {
        modelId: id,
        wireFamily: responsesWire ? "responses" : "chat",
        endpointPath: responsesWire ? "/v1/responses" : "/v1/chat/completions",
        contextLimit: contextWindow,
        outputLimit: outputTokens,
        modalities: { input: hasImage ? ["text", "image"] : ["text"], output: ["text"] },
        reasoning: false,
        toolCall: true,
        cost,
      });
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}

/**
 * Context length from a `modality` array rather than a flat field.
 *
 * Several OpenAI-compatible catalogs (intern-ai's discovery API, among others)
 * declare limits inside `input_modalities[]`, one entry per modality, with the
 * number under `supported_inputs.max_context_length.value`. A flat-only reader
 * saw none of the four flat aliases and fell through to the 200_000 default —
 * so every model on such an upstream was advertised at the same wrong window,
 * which is what routing then sized prompts against. Only the `text` entry
 * carries a context length; an image entry says how images may be supplied.
 */
function modalityContextLimit(entry: Record<string, unknown>): number | null {
  const modalities = entry.input_modalities;
  if (!Array.isArray(modalities)) return null;
  for (const modality of modalities) {
    if (!isRecord(modality)) continue;
    if (modality.type !== "text") continue;
    const supported = modality.supported_inputs;
    if (!isRecord(supported)) continue;
    const max = supported.max_context_length;
    const value = isRecord(max) ? max.value : max;
    const parsed = positiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Output limit from the same array shape, under `output_modalities[].max_length.value`. */
function modalityOutputLimit(entry: Record<string, unknown>): number | null {
  const modalities = entry.output_modalities;
  if (!Array.isArray(modalities)) return null;
  for (const modality of modalities) {
    if (!isRecord(modality)) continue;
    if (modality.type !== "text") continue;
    const max = modality.max_length;
    const value = isRecord(max) ? max.value : max;
    const parsed = positiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Whether an `input_modalities[]` array declares image input. */
function modalityImageInput(entry: Record<string, unknown>): boolean {
  const modalities = entry.input_modalities;
  if (!Array.isArray(modalities)) return false;
  return modalities.some((modality) => isRecord(modality) && modality.type === "image");
}




function extractEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (typeof payload !== "object" || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  for (const key of ["data", "models", "items"] as const) {
    const value = rec[key];
    const bounded = boundedUpstreamArray(value);
    if (bounded) return bounded.filter(isRecord) as Record<string, unknown>[];
  }
  return null;
}
