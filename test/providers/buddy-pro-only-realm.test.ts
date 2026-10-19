/**
 * Pro-only flags are shared by the international CodeBuddy and WorkBuddy model
 * roster. The CN realm does not inherit these international tags.
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

describe("Buddy Pro-only tagging follows measured account scope", () => {
  test("none of the CN roster rows carry proOnly", () => {
    // `proOnly === true` is the only known refusal. absence means tier unknown,
    // and "the intl roster says free" must not propagate to CN.
    const cnRows = [...CODEBUDDY_CN_MODELS, ...WORKBUDDY_CN_MODELS];
    const leaky = cnRows.filter((row) => row.proOnly === true);
    expect(leaky).toEqual([]);
  });

  test("CodeBuddy and WorkBuddy share the same Pro-only model ids", () => {
    const codeBuddyProIds = new Set(
      CODEBUDDY_MODELS.filter((row) => row.proOnly === true).map((row) => row.modelId),
    );
    const workBuddyProIds = new Set(
      WORKBUDDY_MODELS.filter((row) => row.proOnly === true).map((row) => row.modelId),
    );
    const expected = new Set([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gemini-3.5-flash",
      "gemini-3.8-flash",
      "grok-4.6",
      "grok-4.7",
    ]);
    expect(codeBuddyProIds).toEqual(expected);
    expect(workBuddyProIds).toEqual(expected);
  });
});
