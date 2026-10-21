// Trae model rosters.
//
// Each realm has its own roster because upstream really does serve different
// models per deployment — CN is domestic (Doubao/DeepSeek/GLM/Kimi/Qwen),
// intl is frontier (Gemini/Claude/GPT/Grok). Merging them would offer a CN
// account models its realm refuses, which is a runtime failure rather than a
// cosmetic one.
//
// The static rosters are the fallback, not the truth: `discoverTraeModels`
// replaces them with the live `/api/ide/v1/model_list` answer when that
// endpoint works. It works on CN only — intl answers `403 no schema found`, so
// intl stays on its static roster and says so via `modelListSupported`.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { TRAE_CHAT_PATH, type TraeRealm } from "./trae-realm";

/** One roster row, as upstream describes it. */
export interface TraeModelRow {
  /** Upstream key, sent as `model_name`. */
  readonly id: string;
  readonly displayName: string;
  /** Context window, preferring the selectable maximum. */
  readonly ctx: number;
  readonly out: number;
  readonly vision: boolean;
  readonly reasoning: boolean;
}

/** CN roster: 20 chat-face models from the donor's client-state snapshot. */
const TRAE_CN_ROWS: readonly TraeModelRow[] = [
  { id: "Doubao-Seed-Code", displayName: "Seed-Code", ctx: 256000, out: 224000, vision: true, reasoning: true },
  { id: "DeepSeek-V4-Flash-Official", displayName: "DeepSeek-V4-Flash", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "DeepSeek-V4-Pro-Official", displayName: "DeepSeek-V4-Pro", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "deepseek-v4.1-flash", displayName: "DeepSeek-V4.1-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "glm-5.2", displayName: "GLM-5.2", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "glm-5.3", displayName: "GLM-5.3", ctx: 1000000, out: 936000, vision: false, reasoning: true },
  { id: "glm-5.3-flash", displayName: "GLM-5.3-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "glm-5.3-flashx", displayName: "GLM-5.3-FlashX", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "kimi-k2.8-preview", displayName: "Kimi-K2.8-Preview", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "kimi-k3", displayName: "Kimi-K3", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "mimo-v2.6-flash", displayName: "MiMo-V2.6-Flash", ctx: 981504, out: 917504, vision: true, reasoning: false },
  { id: "mimo-v2.6-pro", displayName: "MiMo-V2.6-Pro", ctx: 981504, out: 917504, vision: true, reasoning: false },
  { id: "minimax-m3", displayName: "MiniMax-M3", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "qwen-3.7-plus", displayName: "Qwen3.7-Plus", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "qwen3.8-flash", displayName: "Qwen3.8-Flash", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "qwen3.8-max", displayName: "Qwen3.8-Max", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "Doubao-Seed-2.1-Pro", displayName: "Seed-2.1-Pro-0915", ctx: 1000000, out: 936000, vision: true, reasoning: true },
  { id: "Doubao-Seed-2.1-Turbo", displayName: "Seed-2.1-Turbo", ctx: 256000, out: 224000, vision: true, reasoning: true },
  { id: "Doubao-Seed-Evolving", displayName: "Seed-Evolving", ctx: 1000000, out: 936000, vision: true, reasoning: false },
  { id: "step-5-preview", displayName: "Step-5-Preview", ctx: 1000000, out: 936000, vision: true, reasoning: true },
];

/** intl roster: 10 chat-face models from the donor's client-state snapshot. */
/**
 * Intl roster, verified model by model against a live SG account.
 *
 * Every row here answered a real completion. `claude3.5` and
 * `aws_sdk_claude37_sonnet` are served by `model_list` but answer
 * `3003 all models failed`, so they are absent: a roster row that cannot
 * complete is worse than a missing one.
 *
 * This is the SG catalog. Upstream provisions an account into a region and
 * serves that region's roster, so an account on another intl region sees a
 * different set — which is why `discoverTraeModels` now lists live rather than
 * trusting this list.
 */
/**
 * Intl roster, verified model by model against a live SG account.
 *
 * Every row here answered a real completion through `llm_raw_chat`. The two
 * entries `model_list` also serves — `claude3.5` and `aws_sdk_claude37_sonnet`
 * — answer `3003 all models failed`, so they are absent.
 *
 * This is the **chat** catalog. The much larger list the IDE picker shows
 * (GPT-5.4, GLM-5.2, Kimi-K3, MiniMax-M3, DeepSeek-V4.1-Flash, …) is not this
 * surface: those ids are carried by `modules/ai-agent/harness.dll`, which routes
 * them through the agent protocol (`/api/v1/chat/start_chat` +
 * `/api/v1/chat/subscribe_events` against a `frontierUrl`), not `llm_raw_chat`.
 * Feeding them here was verified to fail with `model is unknown`.
 */
const TRAE_INTL_ROWS: readonly TraeModelRow[] = [
  { id: "gemini-2.5-pro-preview-03-25", displayName: "gemini-2.5-pro-preview-03-25", ctx: 1000000, out: 32768, vision: true, reasoning: true },
  { id: "gemini_2.5_flash", displayName: "gemini_2.5_flash", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  { id: "gpt-4.1-2025-04-14", displayName: "gpt-4.1-2025-04-14", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  { id: "gpt-4o", displayName: "gpt-4o", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  { id: "deepseek-R1", displayName: "deepseek-R1", ctx: 128000, out: 32768, vision: false, reasoning: true },
  { id: "deepseek-V3", displayName: "deepseek-V3", ctx: 128000, out: 32768, vision: false, reasoning: false },
  { id: "deepseek-V3-0324", displayName: "deepseek-V3-0324", ctx: 128000, out: 32768, vision: false, reasoning: false },
];

function traeModels(rows: readonly TraeModelRow[], providerId: string): readonly ModelDefinition[] {
  return rows.map((row) =>
    defineModel({
      id: row.id,
      providerId,
      wireFamily: "chat",
      endpoint: TRAE_CHAT_PATH,
      ctx: row.ctx,
      out: row.out,
      vision: row.vision,
      reasoning: row.reasoning,
    }),
  );
}

export const TRAE_CN_MODELS: readonly ModelDefinition[] = traeModels(TRAE_CN_ROWS, "traecn");
export const TRAE_INTL_MODELS: readonly ModelDefinition[] = traeModels(TRAE_INTL_ROWS, "trae");

/** Roster for a realm. */
export function traeStaticModels(realm: TraeRealm): readonly ModelDefinition[] {
  return realm === "cn" ? TRAE_CN_MODELS : TRAE_INTL_MODELS;
}

/**
 * Reads the largest context window out of one upstream model object.
 *
 * Upstream reports two independent numbers and they are not the same thing:
 * `context_window_size.default` is the window that is active, while
 * `context_window_size.max` is a *list* of selectable windows. Reading only
 * the default is what made the fetcher always pick the smaller number — CN
 * DeepSeek advertises 116k active but 1M selectable, so a client told 116k
 * never asks for the window the account is entitled to.
 *
 * `context_window_tokens` is the older sibling spelling; `dev` pairs with
 * `default` and `max` pairs with `max`.
 */
export function traeMaxContextWindow(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const candidates: number[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(collect);
  };

  const size = record["context_window_size"];
  if (typeof size === "object" && size !== null) {
    const sized = size as Record<string, unknown>;
    collect(sized["max"]);
  }
  const tokens = record["context_window_tokens"];
  if (typeof tokens === "object" && tokens !== null) {
    collect((tokens as Record<string, unknown>)["max"]);
  }
  if (candidates.length > 0) return Math.max(...candidates);

  // No selectable maximum: the active window is all we honestly know.
  if (typeof size === "object" && size !== null) {
    const fallback = (size as Record<string, unknown>)["default"];
    if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  }
  if (typeof tokens === "object" && tokens !== null) {
    const fallback = (tokens as Record<string, unknown>)["dev"];
    if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  }
  const prompt = record["prompt_max_tokens"];
  if (typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0) return prompt;
  return undefined;
}
