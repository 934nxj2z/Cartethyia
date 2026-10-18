/**
 * Buddy model discovery's source of truth.
 *
 * Both reference gateways call `/v3/config` and treat the personal-models path
 * as the narrower fallback. This repo only ever called the latter, so the
 * config path is added *ahead* of it — which makes the ordering itself the
 * thing worth pinning, along with the guarantee that a host answering only the
 * old path still works exactly as before.
 */
import { describe, expect, test } from "bun:test";
import {
  BUDDY_CONFIG_PATH,
  BUDDY_CN_MODELS_PATH,
  BUDDY_INTL_MODELS_PATH,
  fetchBuddyDirectoryModels,
} from "../../src/providers/integrations/buddy/buddy-discovery-shared";

const CATALOG = {
  code: 0,
  data: {
    models: [
      { id: "glm-5.2", name: "GLM 5.2", maxInputTokens: 200_000, maxOutputTokens: 128_000 },
      { id: "gpt-6-astra", name: "GPT-6 Astra", maxInputTokens: 400_000, maxOutputTokens: 32_000 },
    ],
  },
};

/** Records each requested URL and answers `ok` only for `allowed` paths. */
function recordingFetcher(allowed: readonly string[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const ok = allowed.some((path) => String(url).includes(path));
    return new Response(JSON.stringify(CATALOG), {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const base = {
  siteUrl: "https://www.workbuddy.ai",
  providerId: "workbuddy",
  credential: "token",
  endpoint: "/v2/chat/completions",
};

describe("buddy model discovery", () => {
  test("tries /v3/config before the personal-models path", async () => {
    const { calls, fetcher } = recordingFetcher([BUDDY_CONFIG_PATH, BUDDY_INTL_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    expect(models?.length).toBe(2);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(BUDDY_CONFIG_PATH);
  });

  test("falls back to the personal-models path when config is unanswered", async () => {
    const { calls, fetcher } = recordingFetcher([BUDDY_INTL_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    expect(models?.length).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain(BUDDY_CONFIG_PATH);
    expect(calls[1]).toContain(BUDDY_INTL_MODELS_PATH);
  });

  test("returns null when neither path answers", async () => {
    const { fetcher } = recordingFetcher([]);
    expect(
      await fetchBuddyDirectoryModels({ ...base, modelsPath: BUDDY_INTL_MODELS_PATH, fetcher }),
    ).toBeNull();
  });

  test("the CN provider asks the CN path, not the international one", async () => {
    // The CN host answers `/console/…`; the international path on it answers
    // 500 from the edge rather than 404, which reads as an upstream outage.
    const { calls, fetcher } = recordingFetcher([BUDDY_CN_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      siteUrl: "https://www.workbuddy.cn",
      providerId: "workbuddycn",
      credential: "token",
      modelsPath: BUDDY_CN_MODELS_PATH,
      endpoint: "/v2/chat/completions",
      fetcher,
    });
    expect(models?.length).toBe(2);
    expect(calls.some((url) => url.includes(BUDDY_CN_MODELS_PATH))).toBe(true);
    expect(calls.some((url) => url.includes(BUDDY_INTL_MODELS_PATH))).toBe(false);
  });

  test("the config payload's model list is what gets published", async () => {
    // `gpt-6-astra` is in the live `/v3/config` snapshot but absent from the
    // bundled catalog today, so discovery is what surfaces it.
    const { fetcher } = recordingFetcher([BUDDY_CONFIG_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    expect(models?.map((model) => model.modelId)).toContain("gpt-6-astra");
  });
});
