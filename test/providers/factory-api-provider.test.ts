/**
 * Factory `x-api-provider` selector and `x-provider-routing-source`.
 *
 * Research rank #8 documented the header's purpose (a provider selector so
 * traffic does not all take Factory's default routing) but not the accepted
 * value vocabulary. The vocabulary is now pinned from the donor's registry
 * (`packages/catalog/src/wire/factory-droid.ts:30-45`), so these tests pin:
 *
 * - every declared upstream is accepted;
 * - a value outside the vocabulary is dropped, not forwarded;
 * - a caller still cannot inject a header through the value;
 * - no eligible upstream for the account's region surfaces the donor's
 *   region-unavailable error instead of an opaque upstream failure.
 */
import { describe, expect, test } from "bun:test";
import {
  FACTORY_DROID_UPSTREAMS,
  factoryApiProviderHeader,
  factoryInferenceRegion,
  factoryRegionCheckedApiProviderHeader,
  factoryRegionUnavailable,
  factoryRoutingHeaders,
  factoryRoutingSourceHeader,
} from "../../src/providers/integrations/factory/factory";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ResolvedCredential,
} from "../../src/providers/provider-contracts";

/** A dispatch context carrying only the auth_state keys Factory reads. */
function contextWith(authState: Record<string, unknown> | undefined): ProviderDispatchContext {
  const credential = {
    credential_kind: "oauth",
    secret: "envelope",
    ...(authState === undefined ? {} : { auth_state: authState }),
  } as unknown as ResolvedCredential;
  return {
    credential,
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
  } as ProviderDispatchContext;
}

/** A request carrying only what the routing headers read. */
function requestWith(
  providerOptions: Record<string, unknown> | undefined,
  roles: readonly ("user" | "assistant")[] = ["user"],
): CanonicalRequest {
  return {
    model: "claude-opus-5-5",
    messages: roles.map((role, index) => ({
      role,
      content: [{ kind: "text", text: `turn ${index}` }],
    })),
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...(providerOptions === undefined ? {} : { provider_options: providerOptions }),
  } as CanonicalRequest;
}

describe("factoryApiProviderHeader", () => {
  test("accepts every upstream the donor's registry declares", () => {
    // `packages/catalog/src/wire/factory-droid.ts:30-45`, cross-checked against
    // every `upstream-rotation` / `region-upstreams-*` value in
    // `packages/catalog/src/compat/rules/providers/factory-droid.kdl`.
    expect([...FACTORY_DROID_UPSTREAMS]).toEqual([
      "fireworks",
      "baseten",
      "mistral",
      "anthropic",
      "azure_anthropic",
      "vertex_anthropic",
      "bedrock_anthropic",
      "openai",
      "azure_openai",
      "bedrock_openai",
      "google",
      "xai",
      "snowflake",
      "databricks",
    ]);
    for (const upstream of FACTORY_DROID_UPSTREAMS) {
      expect(factoryApiProviderHeader({ factory_api_provider: upstream })).toEqual({
        "x-api-provider": upstream,
      });
    }
  });

  test("emits nothing when the caller names none", () => {
    expect(factoryApiProviderHeader({})).toEqual({});
    expect(factoryApiProviderHeader(undefined)).toEqual({});
  });

  test("emits nothing for a non-string value", () => {
    expect(factoryApiProviderHeader({ factory_api_provider: 42 })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: null })).toEqual({});
  });

  test("emits nothing for an empty string", () => {
    expect(factoryApiProviderHeader({ factory_api_provider: "" })).toEqual({});
  });

  test("refuses a value that would inject a header", () => {
    // The one thing a downstream filter cannot undo: a caller-supplied CRLF
    // turning one header into two.
    expect(factoryApiProviderHeader({ factory_api_provider: "x\r\nx-evil: 1" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "x\nx-evil: 1" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "x\0y" })).toEqual({});
  });

  test("drops an undeclared value instead of forwarding it", () => {
    // Replaces the old pass-through: a token the registry does not declare has
    // no meaning on this wire, so it must not reach Factory.
    expect(factoryApiProviderHeader({ factory_api_provider: "some-unknown-value" })).toEqual({});
    // Near-misses on real upstreams are still undeclared values.
    expect(factoryApiProviderHeader({ factory_api_provider: "bedrock" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "vertex" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "ANTHROPIC" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: " anthropic" })).toEqual({});
    expect(factoryApiProviderHeader({ factory_api_provider: "anthropic " })).toEqual({});
  });
});

describe("factoryRegionCheckedApiProviderHeader", () => {
  test("forwards an upstream the account's region serves", () => {
    // EU serves vertex_anthropic (`factory-droid.kdl:406`).
    const header = factoryRegionCheckedApiProviderHeader(
      requestWith({ factory_api_provider: "vertex_anthropic" }),
      contextWith({ region: "eu" }),
    );
    expect(header).toEqual({ "x-api-provider": "vertex_anthropic" });
  });

  test("emits no selector when the caller names none, whatever the region", () => {
    for (const region of [undefined, { region: "eu" }, { region: "global" }]) {
      expect(
        factoryRegionCheckedApiProviderHeader(requestWith(undefined), contextWith(region)),
      ).toEqual({});
      expect(
        factoryRegionCheckedApiProviderHeader(requestWith({}), contextWith(region)),
      ).toEqual({});
    }
  });

  test("drops an undeclared value before the region check", () => {
    // An undeclared token is never forwarded even in the region that serves the
    // most upstreams; the region check cannot make an unknown value known.
    expect(
      factoryRegionCheckedApiProviderHeader(
        requestWith({ factory_api_provider: "some-unknown-value" }),
        contextWith({ region: "global" }),
      ),
    ).toEqual({});
  });

  test("maps no eligible upstream to the donor's region-unavailable error", () => {
    // `requireUpstream` (`packages/ai/src/providers/factory-droid.ts:100-103`)
    // throws "Factory Droid model is unavailable in this account region."
    const attempt = (): Record<string, string> =>
      factoryRegionCheckedApiProviderHeader(
        requestWith({ factory_api_provider: "fireworks" }),
        contextWith({ region: "eu" }),
      );
    let thrown: unknown;
    try {
      attempt();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { code?: string; status?: number; details?: Record<string, unknown> };
    expect(error.code).toBe("capability_unsupported");
    expect(error.status).toBe(400);
    expect(error.message).toContain("unavailable in this account region");
    expect(error.message).toContain("eu");
    // The donor's own message text travels so the mapping is traceable.
    expect(error.details?.["reason"]).toBe(
      "Factory Droid model is unavailable in this account region.",
    );
    expect(error.details?.["model"]).toBe("claude-opus-5-5");
    expect(error.details?.["region"]).toBe("eu");
  });

  test("the region-unavailable error is a typed GatewayError", () => {
    const error = factoryRegionUnavailable("gpt-5.5", "eu");
    expect(error.name).toBe("GatewayError");
    expect(error.code).toBe("capability_unsupported");
    expect(error.message).toBe(
      "factory: gpt-5.5 is unavailable in this account region (eu)",
    );
  });

  test("a global account keeps every declared upstream", () => {
    for (const upstream of FACTORY_DROID_UPSTREAMS) {
      expect(
        factoryRegionCheckedApiProviderHeader(
          requestWith({ factory_api_provider: upstream }),
          contextWith(undefined),
        ),
      ).toEqual({ "x-api-provider": upstream });
    }
  });
});

describe("factoryInferenceRegion", () => {
  test("defaults to global", () => {
    expect(factoryInferenceRegion(contextWith(undefined))).toBe("global");
    expect(factoryInferenceRegion(contextWith({}))).toBe("global");
    expect(factoryInferenceRegion(contextWith({ region: "global" }))).toBe("global");
  });

  test("EU residency infers EU inference", () => {
    expect(factoryInferenceRegion(contextWith({ region: "eu" }))).toBe("eu");
  });

  test("an explicit inference region wins over residency", () => {
    // `packages/catalog/src/wire/factory-droid.ts:61-67`: the two axes are
    // independent, and an EU-host account may have global inference.
    expect(
      factoryInferenceRegion(contextWith({ region: "eu", inference_region: "global" })),
    ).toBe("global");
    expect(
      factoryInferenceRegion(contextWith({ region: "global", inference_region: "eu" })),
    ).toBe("eu");
    expect(factoryInferenceRegion(contextWith({ inferenceRegion: "us" }))).toBe("us");
  });
});

describe("factoryRoutingSourceHeader", () => {
  test("reports registry_default on a first turn", () => {
    // `packages/ai/src/providers/factory-droid.ts:586-593`.
    expect(factoryRoutingSourceHeader(requestWith(undefined))).toEqual({
      "x-provider-routing-source": "registry_default",
    });
  });

  test("reports session_lock once the session has a served turn", () => {
    expect(factoryRoutingSourceHeader(requestWith(undefined, ["user", "assistant"]))).toEqual({
      "x-provider-routing-source": "session_lock",
    });
  });
});

describe("factoryRoutingHeaders", () => {
  test("sends both routing headers, or only the routing source", () => {
    expect(
      factoryRoutingHeaders(
        requestWith({ factory_api_provider: "anthropic" }),
        contextWith(undefined),
      ),
    ).toEqual({
      "x-api-provider": "anthropic",
      "x-provider-routing-source": "registry_default",
    });
    expect(factoryRoutingHeaders(requestWith(undefined), contextWith(undefined))).toEqual({
      "x-provider-routing-source": "registry_default",
    });
  });

  test("still refuses an upstream the region does not serve", () => {
    expect(() =>
      factoryRoutingHeaders(
        requestWith({ factory_api_provider: "fireworks" }),
        contextWith({ region: "eu" }),
      ),
    ).toThrow(/unavailable in this account region/);
  });
});
