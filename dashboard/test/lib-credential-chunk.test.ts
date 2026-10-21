/**
 * Batch-import chunking.
 *
 * A paste of thousands of accounts cannot go as one request: the server caps a
 * batch (100 accounts) so a single paste cannot open an unbounded transaction.
 * Sending the whole paste anyway is rejected outright, and sending one request
 * per account is N round-trips. Chunking is the middle: every request is
 * inside the cap, and the number of round-trips stays bounded.
 */
import { describe, expect, test } from "bun:test";
import {
  chunkCredentials,
  MAX_ACCOUNTS_PER_BATCH_REQUEST,
} from "../src/lib/credentials";

describe("chunkCredentials", () => {
  test("keeps every request inside the server's cap", () => {
    expect(MAX_ACCOUNTS_PER_BATCH_REQUEST).toBeLessThanOrEqual(100);
  });

  test("splits a large paste into capped chunks", () => {
    const items = Array.from({ length: 133 }, (_, i) => i);
    const chunks = chunkCredentials(items, 50);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 33]);
  });

  test("loses nothing and reorders nothing", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    expect(chunkCredentials(items, 50).flat()).toEqual(items);
  });

  test("a paste smaller than one chunk is a single chunk", () => {
    expect(chunkCredentials([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  test("an empty paste is no chunks", () => {
    expect(chunkCredentials([], 50)).toEqual([]);
  });

  test("an exact multiple leaves no trailing empty chunk", () => {
    expect(chunkCredentials([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("a chunk size below one is rejected rather than looping forever", () => {
    expect(() => chunkCredentials([1, 2], 0)).toThrow(RangeError);
  });
});
