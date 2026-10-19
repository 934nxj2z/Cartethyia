/**
 * Hermes' portal `tags` are a required field, not optional attribution.
 *
 * Measured against the live API — the endpoint rejects a request with no `user=`
 * tag and answers 400 `missing user tag`:
 *
 *   tags=[user=u1]   → 200      tags=[a=b]   → 400 missing user tag
 *   tags=[user=]     → 200      tags=[x]     → 400 missing user tag
 *   tags=[] / absent → 400      no user tag  → 400
 *
 * The value is not validated, so this is a shape requirement. What must not
 * drift is that it is present at all: `poolside/laguna-s-2.1:free` and
 * `meituan/longcat-2.5-preview:free` answer 200 with only `product=` and
 * `client=`, which is why the omission went unnoticed — `upstage/solar-mini4:free`
 * and both stepfun rows reject the same request outright.
 *
 * The client tag tracks the released Hermes tag, which is date-based. Hermes
 * publishes no semver, so a `v0.13.0` client string names a version that never
 * existed.
 */
import { describe, expect, test } from "bun:test";
import { HERMES_MODELS, HERMES_SPEC } from "../../src/providers/integrations/hermes";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const REQUEST: CanonicalRequest = {
  model: "upstage/solar-mini4:free",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

const TARGET: ProviderDispatchTarget = {
  provider_id: "hermes",
  model_id: "upstage/solar-mini4:free",
  wire_family: "chat",
  endpoint_path: "/v1/chat/completions",
  capabilities: {},
};

function tagsFor(payload: Record<string, unknown> = {}): readonly string[] {
  HERMES_SPEC.prePayload?.(payload, REQUEST, TARGET);
  const tags = payload["tags"];
  if (!Array.isArray(tags)) throw new Error("prePayload did not write tags");
  return tags as readonly string[];
}

describe("hermes portal tags", () => {
  test("a user tag is always present", () => {
    // The one requirement the endpoint actually enforces.
    expect(tagsFor().some((tag) => tag.startsWith("user="))).toBe(true);
  });

  test("the user tag is not a fabricated end-user identity", () => {
    // The value is unvalidated, so anything passes — which is exactly why a
    // made-up name would ship unnoticed. It names the client instead.
    const user = tagsFor().find((tag) => tag.startsWith("user="));
    expect(user).toBe("user=hermes-agent");
  });

  test("the client tag names a Hermes release that exists", () => {
    // Date-based: Hermes publishes `v2026.9.24`, not a semver. A `v0.13.0`
    // client string is a version Hermes never had.
    const client = tagsFor().find((tag) => tag.startsWith("client="));
    expect(client).toBe("client=hermes-client-v2026.9.24");
  });

  test("prePayload replaces tags rather than appending to them", () => {
    // A caller-supplied tag must not survive alongside the required set, or the
    // payload would carry two identities.
    const tags = tagsFor({ tags: ["user=someone-else"] });
    expect(tags.filter((tag) => tag.startsWith("user="))).toEqual(["user=hermes-agent"]);
  });

  test("the static roster is the live free set", () => {
    // `meituan/longcat-2.0:free` answered 404 "This model is no longer free",
    // so it is not here; its successor is.
    const ids = HERMES_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual([
      "meituan/longcat-2.5-preview:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "reflection/beam-1.0-501b-a23b:free",
      "stepfun/step-3.7-flash:free",
      "stepfun/step-5-preview:free",
      "upstage/solar-mini4:free",
    ]);
  });
});
