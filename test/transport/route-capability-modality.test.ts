/**
 * A declared input modality must win over the codec's rich-content grant.
 *
 * `buildCapabilityProfile` used to compute `image: inputMods.includes("image") || codecEncodesRichContent`,
 * which made the grant an *override*: every row on a canonical-codec provider
 * claimed image support even when the catalog declared `["text"]`. Qoder is
 * that case — it has no bespoke wire, so the grant fired, and an image was
 * forwarded to an upstream that rejects it. The catalog's own `is_vl: false`
 * never mattered.
 *
 * `defineModel` always seeds `"text"`, so a non-empty array is an explicit
 * declaration and its contents are authoritative; an empty array is a row that
 * carried no modality metadata, which is the pass-through case the grant
 * exists to protect. Both directions are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { buildCapabilityProfile } from "../../src/transport/routing/route-catalog";

/** A canonical-codec provider with no bespoke wire. */
const QODER = "qoder";
/** A bespoke-wire provider, for which the grant never fires at all. */
const CURSOR = "cursor";

describe("buildCapabilityProfile input modalities", () => {
  test("a declared text-only row is not image-capable", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: QODER,
    });
    expect(profile.image).toBe(false);
    expect(profile.document).toBe(false);
    expect(profile.audio).toBe(false);
  });

  test("a declared image row is image-capable", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: QODER,
    });
    expect(profile.image).toBe(true);
  });

  test("a declared document row keeps document and drops the rest", () => {
    const profile = buildCapabilityProfile({
      modalities: { input: ["text", "document"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: QODER,
    });
    expect(profile.document).toBe(true);
    expect(profile.image).toBe(false);
    expect(profile.audio).toBe(false);
  });

  test("a row with no modality metadata keeps the codec grant", () => {
    // Discovered and legacy rows: absent metadata must not degrade a caller's
    // attachment to text on the strength of a guess.
    const profile = buildCapabilityProfile({
      modalities: { input: [], output: [] },
      reasoning: false,
      toolCall: false,
      providerId: QODER,
    });
    expect(profile.image).toBe(true);
    expect(profile.document).toBe(true);
    expect(profile.audio).toBe(true);
  });

  test("a bespoke-wire provider declares no codec modalities either way", () => {
    const declared = buildCapabilityProfile({
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: false,
      toolCall: false,
      providerId: CURSOR,
    });
    const undeclared = buildCapabilityProfile({
      modalities: { input: [], output: [] },
      reasoning: false,
      toolCall: false,
      providerId: CURSOR,
    });
    expect(declared.bespokeWire).toBe(true);
    expect(undeclared.bespokeWire).toBe(true);
    expect(undeclared.image).toBe(false);
    expect(declared.image).toBe(true);
  });
});
