/**
 * Command Code model discovery, read from the Provider API.
 *
 * The adapter used to carry a hand-copied list of 36 ids with no limits and one
 * wire for all of them. The Provider API publishes the real roster — 95 rows,
 * each stating `context_length` and `supported_endpoints` — so this replaces
 * that snapshot with what the provider actually serves.
 *
 * Two facts the snapshot could not express, and both change what is routable:
 *
 *   * Every `claude-*` id is served on `/messages` only. A catalog that filed
 *     them as chat posted to an endpoint that does not answer them, so all nine
 *     were unusable.
 *
 *   * Many ids also serve `/responses`. The wire is chosen per model from
 *     `supported_endpoints`, which is the provider's own advertisement, rather
 *     than guessed from the id.
 *
 * `:free` is deliberately NOT read as a free tier here. Verified against the
 * live API: `minimax/minimax-m3.1-flash-preview:free`, `stealth/cat-jam:free`,
 * `stealth/glyph-cluster:free` and `reflection/beam:free` all answer 400
 * "insufficient credits" on an account whose `freeCredits` is 0. The suffix is
 * part of the upstream id, not a pricing statement — the opposite of
 * OpenRouter, Kilo and Cline, where `:free` is the tier. Marking it here would
 * publish paid models as free, which is the defect fixed on Cline.
 */
import type { ModelDefinition } from "../../provider-model-definition";
import { isRecord } from "../../../protocol/codecs";
import { boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";
import type { ProviderModelDiscovery } from "../../discovery/discovery-types";
import { defineModel } from "../../provider-model-definition";
import { COMMANDCODE_PROVIDER_ID } from "./commandcode";

/** The Provider API's OpenAI-shaped model listing. */
export const COMMANDCODE_MODELS_PATH = "/models" as const;

/** The route that selects the OpenAI Responses wire when a model lists it. */
const RESPONSES_ENDPOINT = "/responses" as const;
const ANTHROPIC_MESSAGES_ENDPOINT = "/messages" as const;

const MAX_CONTEXT = 1_000_000_000;

/**
 * The wire a model is served on.
 *
 * `claude-*` answers `/messages` only. Everything else answers
 * `/chat/completions`, and adds `/responses` when the listing advertises it.
 * Without endpoint metadata a model keeps chat, which every non-Claude model
 * serves, so a listing that omits the field never breaks.
 */
export function commandCodeWireFor(
  modelId: string,
  supportedEndpoints?: readonly string[],
): { readonly wireFamily: "messages" | "responses" | "chat"; readonly endpointPath: string } {
  if (modelId.startsWith("claude-")) {
    return { wireFamily: "messages", endpointPath: ANTHROPIC_MESSAGES_ENDPOINT };
  }
  if (supportedEndpoints?.includes(RESPONSES_ENDPOINT)) {
    return { wireFamily: "responses", endpointPath: RESPONSES_ENDPOINT };
  }
  return { wireFamily: "chat", endpointPath: "/chat/completions" };
}

/** Reads `supported_endpoints` tolerantly — unknown rows keep the chat wire. */
function endpointList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export const discoverCommandCodeModels: ProviderModelDiscovery = async (
  input,
): Promise<readonly ModelDefinition[] | null> => {
  const fetcher = input.fetcher ?? fetch;
  const signal = AbortSignal.timeout(10_000);
  try {
    const base = input.baseUrl.replace(/\/+$/, "");
    const response = await fetcher(`${base}${COMMANDCODE_MODELS_PATH}`, {
      headers: { accept: "application/json", authorization: `Bearer ${input.credential}` },
      signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const rows = Array.isArray(body["data"]) ? body["data"] : [];
    const byId = new Map<string, ModelDefinition>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = sanitizeUpstreamLabel(row["id"]);
      if (id === undefined) continue;
      const contextLimit = boundedUpstreamNumber(row["context_length"], { min: 1, max: MAX_CONTEXT });
      const { wireFamily, endpointPath } = commandCodeWireFor(
        id,
        endpointList(row["supported_endpoints"]),
      );
      byId.set(
        id,
        defineModel({
          id,
          providerId: COMMANDCODE_PROVIDER_ID,
          wireFamily,
          endpoint: endpointPath,
          // `null` when the row states no limit, which is not a guess: the
          // routing ladder keeps its own fallback.
          ctx: contextLimit ?? null,
          reasoning: true,
          toolCall: true,
          vision: true,
        }),
      );
    }
    if (byId.size === 0) return null;
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
};
