import { describe, expect, test } from "bun:test";
import {
  DEFAULT_API_KEY_PREFIX,
  DEFAULT_SHARE_API_KEY_PREFIX,
  generateApiKeySecret,
  resolveShareKeyPrefix,
} from "../../src/console/api-keys/contracts";

describe("API key prefixes", () => {
  test("personal credentials use carte_ followed by 12 random characters", () => {
    const generated = generateApiKeySecret();

    expect(generated.prefix).toBe(DEFAULT_API_KEY_PREFIX);
    expect(generated.secret).toMatch(/^carte_[A-Za-z0-9_-]{12}$/);
  });

  test("share credentials use sh-carte_ and upgrade the legacy default", () => {
    expect(resolveShareKeyPrefix(undefined)).toBe(DEFAULT_SHARE_API_KEY_PREFIX);
    expect(resolveShareKeyPrefix("rk_")).toBe(DEFAULT_SHARE_API_KEY_PREFIX);
    expect(resolveShareKeyPrefix("custom_")).toBe("custom_");

    const generated = generateApiKeySecret(resolveShareKeyPrefix("rk_"));
    expect(generated.secret).toMatch(/^sh-carte_[A-Za-z0-9_-]{12}$/);
  });
});
