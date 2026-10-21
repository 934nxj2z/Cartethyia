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
import { TRAE_AGENT_CHAT_PATH, TRAE_CHAT_PATH, type TraeRealm } from "./trae-realm";

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
  /**
   * Surface this row belongs to.
   *
   * Defaults to `"chat"`. The picker's models must be `"agent"`: they are
   * absent from `model_list` and answer `4023 model is unknown` on the chat
   * path no matter which host is tried.
   */
  readonly surface?: TraeSurface;
}

/** Which upstream endpoint serves a row. */
export type TraeSurface = "chat" | "agent";

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

/**
 * Intl roster, every row confirmed by a real completion on a live SG account.
 *
 * Two surfaces are mixed here and that is deliberate: upstream splits them and
 * a client that only knows one sees half the catalog. Chat rows are answered by
 * `llm_raw_chat` and keyed by `model_name`; agent rows are answered by
 * `llm_utils_chat` and keyed by `config_name`. See
 * `documentation/research/trae-agent-vs-chat-surface.md`.
 *
 * The legacy DeepSeek entries (`deepseek-R1`, `deepseek-V3`, `deepseek-V3-0324`)
 * are dropped: the picker's DeepSeek-V4 row supersedes them and the old ids add
 * three near-duplicates to a list where one suffices.
 *
 * `claude3.5` and `aws_sdk_claude37_sonnet` are served by `model_list` but
 * answer `3003 all models failed`, so they stay absent — a roster row that
 * cannot complete is worse than a missing one.
 *
 * Numbers come from `batch_get_detail_param`: `context_window_tokens.dev` for
 * the window and `model_detail_list[0].max_tokens` for the output cap. Agent
 * rows report their real upstream in `timing_cost.provider_model_name`, which
 * is often not the id sent (DeepSeek-V4.1-Flash resolves to `ep-2026…-69njn`),
 * so the id is the config name, never the resolved one.
 */
const TRAE_INTL_ROWS: readonly TraeModelRow[] = [
  // chat surface — the account's `model_list?type=chat` rows that complete
  { id: "gemini-2.5-pro-preview-03-25", displayName: "gemini-2.5-pro-preview-03-25", ctx: 1000000, out: 32768, vision: true, reasoning: true },
  { id: "gemini_2.5_flash", displayName: "gemini_2.5_flash", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  { id: "gpt-4.1-2025-04-14", displayName: "gpt-4.1-2025-04-14", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  { id: "gpt-4o", displayName: "gpt-4o", ctx: 1000000, out: 32768, vision: true, reasoning: false },
  // agent surface — the IDE picker's roster
  { id: "gpt-5.4", displayName: "GPT-5.4", ctx: 272000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "gpt-5.2", displayName: "GPT-5.2", ctx: 272000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "gpt-5.2-codex-paygo", displayName: "gpt-5.2-codex-paygo", ctx: 272000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "gpt-5.1-paygo", displayName: "GPT-5.1", ctx: 272000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "gpt-5-paygo", displayName: "GPT-5", ctx: 272000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "Dola-Seed-2.0-Code", displayName: "Seed-2.1-Turbo", ctx: 200000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "deepseek-v4.1-flash", displayName: "DeepSeek-V4.1-Flash", ctx: 200000, out: 64000, vision: false, reasoning: true, surface: "agent" },
  { id: "deepseek-v4-flash-0731", displayName: "DeepSeek-V4-Flash", ctx: 200000, out: 64000, vision: false, reasoning: true, surface: "agent" },
  { id: "deepseek-v4-pro-0813", displayName: "DeepSeek-V4-Pro", ctx: 200000, out: 64000, vision: false, reasoning: true, surface: "agent" },
  { id: "kimi-k3", displayName: "Kimi-K3", ctx: 200000, out: 64000, vision: true, reasoning: true, surface: "agent" },
  { id: "kimi-k2.7-code", displayName: "Kimi-K2.7-Code", ctx: 200000, out: 64000, vision: true, reasoning: true, surface: "agent" },
  { id: "kimi-k2.5", displayName: "Kimi-K2.5", ctx: 200000, out: 32000, vision: false, reasoning: true, surface: "agent" },
  { id: "gemini-3.1-pro", displayName: "Gemini-3.1-Pro-Preview", ctx: 200000, out: 64000, vision: true, reasoning: true, surface: "agent" },
  { id: "gemini-3.1-pro-paygo", displayName: "Gemini-3.1-Pro-Preview", ctx: 200000, out: 32000, vision: true, reasoning: true, surface: "agent" },
  { id: "gemini-3-flash-solo", displayName: "Gemini-3-Flash-Preview", ctx: 200000, out: 64000, vision: true, reasoning: true, surface: "agent" },
  { id: "minimax-m3", displayName: "MiniMax-M3", ctx: 200000, out: 64000, vision: true, reasoning: true, surface: "agent" },
  { id: "minimax-m2.7", displayName: "MiniMax-M2.7", ctx: 200000, out: 32000, vision: false, reasoning: true, surface: "agent" },
];

function traeModels(rows: readonly TraeModelRow[], providerId: string): readonly ModelDefinition[] {
  return rows.map((row) =>
    defineModel({
      id: row.id,
      providerId,
      wireFamily: "chat",
      endpoint: row.surface === "agent" ? TRAE_AGENT_CHAT_PATH : TRAE_CHAT_PATH,
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
