import { describe, expect, test } from "bun:test";
import { generateShareSlug, hashShareToken } from "../../src/persistence/stores/share-store";

/**
 * The share page's public slug.
 *
 * `token_encrypted` is the bearer token sealed under the deployment's
 * encryption key, so a backup restored onto a fresh deployment — which by
 * definition has a different key — could not re-display any share link. The
 * slug is the address half, held in the clear, so a restored page keeps the
 * URL it was created with.
 *
 * Held unencrypted, it is the only thing standing between a guess and someone
 * else's share page, so it must carry the same entropy as the token it names.
 */
describe("share link slug", () => {
  test("carries 256 bits of entropy", () => {
    // 32 random bytes, base64url — 43 characters, unpadded.
    expect(generateShareSlug()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("is url-safe", () => {
    // The slug is interpolated straight into a path segment; a `+`, `/`, or `=`
    // here would either break the URL or silently change which page it names.
    for (let i = 0; i < 50; i += 1) {
      expect(generateShareSlug()).not.toMatch(/[+/=]/);
    }
  });

  test("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateShareSlug());
    expect(seen.size).toBe(500);
  });

  test("is not the token hash", () => {
    // The slug is a lookup key of its own. Deriving it from the token would
    // publish a function of the secret in the URL.
    const slug = generateShareSlug();
    expect(slug).not.toBe(hashShareToken(slug));
  });
});
