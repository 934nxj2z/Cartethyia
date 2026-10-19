/**
 * `BUDDY_PRO_ONLY_MODEL_IDS` is the set of model ids whose refusal on a free
 * plan was measured by dispatching a free-account probe on the intl (`cb`,
 * `workbuddy`) realm. The CN realm (`cbcn`, `workbuddycn`) was deliberately
 * not measured — every probe there would land on a server that does not gate
 * models on plan at all — so the same set applied to a CN row would publish
 * a tier fact that nobody measured and that a CN dispatch would simply
 * disagree with.
 *
 * The test pins the realm split at `makeBuddyModel`. It is a unit over the
 * shared helper because that is where the conditioning lives; the intl-only
 * guarantee must hold regardless of how discovery or seeding later changes.
 */
import { describe, expect, test } from "bun:test";
import { CODEBUDDY_MODELS } from "../../src/providers/integrations/buddy/codebuddy/provider";
import { CODEBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/codebuddy/cn-provider";
import { WORKBUDDY_MODELS } from "../../src/providers/integrations/buddy/workbuddy/provider";
import { WORKBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/workbuddy/cn-provider";

describe("pro-only tagging is intl-only", () => {
  test("none of the CN roster rows carry proOnly", () => {
    // `proOnly === true` is the only known refusal. absence means tier unknown,
    // and "the intl roster says free" must not propagate to CN.
    const cnRows = [...CODEBUDDY_CN_MODELS, ...WORKBUDDY_CN_MODELS];
    const leaky = cnRows.filter((row) => row.proOnly === true);
    expect(leaky).toEqual([]);
  });

  test("intl rows in the rejection set are still proOnly", () => {
    // The opposite guarantee: the realm guard does not strip the intl rows
    // the probe actually established.
    const intlPro = [...CODEBUDDY_MODELS, ...WORKBUDDY_MODELS].filter(
      (row) => row.proOnly === true,
    );
    const intlProIds = new Set(intlPro.map((row) => row.modelId));
    // The set the probe measured. CN-only ids are out of scope.
    const expected = new Set([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gemini-3.5-flash",
    ]);
    expect(intlProIds).toEqual(expected);
  });
});
