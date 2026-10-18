/**
 * Auto-generated account labels for credentials that arrive nameless.
 *
 * A polished API key or a plain JWT carries no identity of its own, so an
 * operator pasting several into one provider used to get every row named
 * "<providerId> account": five accounts, five identical labels, and a list
 * that could not say which one failed or which one is cooling.
 *
 * An OAuth paste is deliberately not renamed — it carries the account it was
 * exported from in `authState`, so generating a name would overwrite an
 * identity that was already there. Only the two nameless kinds get one.
 *
 * Pure helpers, so the numbering is pinned without a database.
 */
import { describe, expect, test } from "bun:test";
import {
  accountLabelKindSegment,
  nextGeneratedAccountLabel,
} from "../../src/console/providers/catalog/store";

describe("accountLabelKindSegment", () => {
  test("an api_key credential is labelled key", () => {
    expect(accountLabelKindSegment("api_key")).toBe("key");
  });

  test("a plain JWT is labelled jwt", () => {
    expect(accountLabelKindSegment("jwt")).toBe("jwt");
  });

  test("an undetected mode falls back to key", () => {
    // `auto` is how it is stored until detection settles; it must still yield
    // a usable name rather than an empty segment.
    expect(accountLabelKindSegment("auto")).toBe("key");
  });
});

describe("nextGeneratedAccountLabel", () => {
  test("numbers from one on an empty provider", () => {
    expect(nextGeneratedAccountLabel("dcint", "api_key", [])).toBe("dcint-key-1");
    expect(nextGeneratedAccountLabel("dcint", "jwt", [])).toBe("dcint-jwt-1");
  });

  test("each kind numbers independently", () => {
    // A first JWT must not inherit the api_key rows' count: `dcint-jwt-3` with
    // no jwt-1 or jwt-2 reads as two missing accounts.
    const existing = ["dcint-key-1", "dcint-key-2"];
    expect(nextGeneratedAccountLabel("dcint", "jwt", existing)).toBe("dcint-jwt-1");
    expect(nextGeneratedAccountLabel("dcint", "api_key", existing)).toBe("dcint-key-3");
  });

  test("a sequence of pastes stays distinguishable", () => {
    const labels: string[] = [];
    for (const mode of ["api_key", "api_key", "jwt", "api_key"] as const) {
      labels.push(nextGeneratedAccountLabel("dcint", mode, labels));
    }
    expect(labels).toEqual([
      "dcint-key-1",
      "dcint-key-2",
      "dcint-jwt-1",
      "dcint-key-3",
    ]);
  });

  test("a gap in the numbers is filled", () => {
    // A deleted account must not leave a number permanently unused.
    expect(
      nextGeneratedAccountLabel("dcint", "api_key", ["dcint-key-1", "dcint-key-3"]),
    ).toBe("dcint-key-2");
  });

  test("a hand-typed label reserves its number case-insensitively", () => {
    expect(nextGeneratedAccountLabel("dcint", "api_key", ["DCINT-KEY-1"])).toBe("dcint-key-2");
  });

  test("another provider's numbering does not collide", () => {
    expect(nextGeneratedAccountLabel("other", "api_key", ["dcint-key-1"])).toBe("other-key-1");
  });

  test("an existing unrelated label is left alone", () => {
    // Names the operator chose are not part of the generated series, so they
    // must not shift the count.
    expect(
      nextGeneratedAccountLabel("dcint", "api_key", ["dcint account", "prod billing"]),
    ).toBe("dcint-key-1");
  });

  test("it terminates even with a long existing run", () => {
    const many = Array.from({ length: 500 }, (_, i) => `dcint-key-${i + 1}`);
    expect(nextGeneratedAccountLabel("dcint", "api_key", many)).toBe("dcint-key-501");
  });
});
