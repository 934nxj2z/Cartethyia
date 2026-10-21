/**
 * The OpenCode Free and Zen tiers dispatch on `/inference/v1`, not `/zen/v1`.
 *
 * `/zen/v1/models` publishes the catalog while `/inference/v1/models` answers
 * 404, so the two bases look interchangeable — and they are not. A byte-exact
 * replay against `/inference/v1` returned 200 where `/zen/v1` did not, and the
 * gateway kept failing because every model row carried an explicit `/zen/v1`
 * endpoint, which outranks the per-provider wire-family table at dispatch.
 *
 * Go stays on its own base.
 */
import { describe, expect, test } from "bun:test";
import { providerBaseUrl } from "../../src/providers/provider-metadata";
import {
  OPENCODE_FREE_MODELS,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
} from "../../src/providers/integrations/opencode/provider";

function dispatchUrl(providerId: "opencode" | "opencode-zen" | "opencode-go", endpointPath: string): string {
  return providerBaseUrl(providerId).replace(/\/+$/, "") + endpointPath;
}

describe("OpenCode dispatch base", () => {
  test("free and zen models dispatch on /inference/v1", () => {
    for (const model of [...OPENCODE_FREE_MODELS, ...OPENCODE_ZEN_MODELS]) {
      expect(model.endpointPath.startsWith("/inference/v1/")).toBe(true);
    }
  });

  test("a free model lands on the URL a replay proved returns 200", () => {
    const free = OPENCODE_FREE_MODELS.find((model) => model.modelId === "longcat-2.5-preview-free");
    expect(dispatchUrl("opencode", free?.endpointPath ?? "")).toBe(
      "https://opencode.ai/inference/v1/chat/completions",
    );
  });

  test("the deprecated muse contributor id is not catalogued", () => {
    // This row was dropped as deprecated, restored on the strength of a 200
    // seen on the Responses wire, and dropped again: the live Zen roster does
    // not list `muse-spark-1.2-contributor-free` at all. A 200 from one probe
    // does not outrank the provider's own roster — an id absent from it is an
    // id that can disappear without notice, which is exactly what a stale row
    // is. `muse-spark-1.2` and `muse-spark-1.3` remain listed.
    const muse = OPENCODE_FREE_MODELS.find(
      (model) => model.modelId === "muse-spark-1.2-contributor-free",
    );
    expect(muse).toBeUndefined();
  });

  test("the genuinely deprecated muse free id stays out", () => {
    // 1.3 answers `410 ModelDeprecated` on every wire, so it is not a shape
    // problem and must not be catalogued.
    const deprecated = OPENCODE_FREE_MODELS.find(
      (model) => model.modelId === "muse-spark-1.3-contributor-free",
    );
    expect(deprecated).toBeUndefined();
  });

  test("go keeps its own base", () => {
    for (const model of OPENCODE_GO_MODELS) {
      expect(model.endpointPath.startsWith("/zen/go/v1/")).toBe(true);
    }
  });
});
