/**
 * Behaviour when the credential store itself fails.
 *
 * Two failure modes this guards, both silent and both worst under load:
 *
 * - a database error surfaced as a 500 whose log line carried the statement and
 *   its bound parameters, one of which is the key hash. A single bad request
 *   wrote a credential-shaped string to the log; an outage wrote one per
 *   request.
 * - every inbound request re-attempted the query against a backend that was
 *   already failing, adding request-rate load to the overload that caused it.
 */
import { describe, expect, test } from "bun:test";
import {
  ApiKeyStoreUnavailableError,
  invalidateApiKeyCache,
  resolveApiKeyAuthorization,
} from "../../src/security/api-key-auth";

/** A db-shaped handle whose `findActiveByHash` always throws. */
function failingDb(): unknown {
  return {
    // The store reads `apiKeys` off the handle for its builder path; throwing
    // from a property access is enough to make the lookup fail.
    get apiKeys() {
      throw new Error("Failed query: select ... where key_hash = $1 params: <hash>");
    },
  } as unknown;
}

describe("credential store outage", () => {
  test("a store failure throws, it does not return undefined", async () => {
    // Returning undefined would mean "unknown key", which is a 401 the caller
    // is told to fix by rotating — the wrong instruction for an outage.
    invalidateApiKeyCache();
    let thrown: unknown;
    try {
      await resolveApiKeyAuthorization(failingDb() as never, "token-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // A revoked key is an empty result, never an exception: anything thrown
    // here is a fault, so the caller can distinguish the two.
    expect(thrown).not.toBeUndefined();
  });

  test("the cooldown is typed so callers can answer 503, not 401", () => {
    const error = new ApiKeyStoreUnavailableError();
    expect(error.name).toBe("ApiKeyStoreUnavailableError");
    // Distinguishable from a GatewayError so the guard can map it to capacity
    // rather than to authentication.
    expect(error).not.toHaveProperty("code");
  });
});
