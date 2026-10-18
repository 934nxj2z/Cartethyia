import { describe, expect, test } from "bun:test";
import { initialApiKeyScopes } from "../src/components/ApiKeyForm";
import { TENANT_KEY_SCOPES } from "../src/data/contracts";

describe("initialApiKeyScopes", () => {
  test("the default gateway key starts with every tenant scope, including routing and remote mappings", () => {
    expect(initialApiKeyScopes({ isDefault: true, scopes: ["routing:invoke"] })).toEqual([
      ...TENANT_KEY_SCOPES,
    ]);
  });

  test("ordinary keys preserve explicit scopes and new keys keep the limited routing defaults", () => {
    expect(initialApiKeyScopes({ scopes: ["dashboard:read"] })).toEqual(["dashboard:read"]);
    expect(initialApiKeyScopes(null)).toEqual(["routing:invoke", "search:invoke"]);
  });
});
