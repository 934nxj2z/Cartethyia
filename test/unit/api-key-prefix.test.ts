import { describe, expect, test } from "bun:test";
import {
  DEFAULT_API_KEY_PREFIX,
  DEFAULT_SHARE_API_KEY_PREFIX,
  generateApiKeySecret,
  resolveShareKeyPrefix,
} from "../../src/console/api-keys/contracts";

describe("API key prefixes", () => {
  test("personal credentials use pn-carte- followed by 16 random characters", () => {
    const generated = generateApiKeySecret();

    expect(generated.prefix).toBe(DEFAULT_API_KEY_PREFIX);
    expect(generated.secret).toMatch(/^pn-carte-[A-Za-z0-9_-]{16}$/);
  });

  test("share credentials use sh-carte- and upgrade the legacy default", () => {
    expect(resolveShareKeyPrefix(undefined)).toBe(DEFAULT_SHARE_API_KEY_PREFIX);
    expect(resolveShareKeyPrefix("rk_")).toBe(DEFAULT_SHARE_API_KEY_PREFIX);
    expect(resolveShareKeyPrefix("custom_")).toBe("custom_");

    const generated = generateApiKeySecret(resolveShareKeyPrefix("rk_"));
    expect(generated.secret).toMatch(/^sh-carte-[A-Za-z0-9_-]{16}$/);
  });

  test("the tail is 16 characters for every generated key", () => {
    // The prefix length is caller-controlled, so pin the part that must be
    // constant: 12 bytes base64url-encode to exactly 16 characters.
    for (const prefix of [DEFAULT_API_KEY_PREFIX, DEFAULT_SHARE_API_KEY_PREFIX, "x-"]) {
      const { secret } = generateApiKeySecret(prefix);
      expect(secret.slice(prefix.length)).toHaveLength(16);
    }
  });
});
