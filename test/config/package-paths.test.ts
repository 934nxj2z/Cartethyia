import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePackageRoot } from "../../src/config/package-paths";

describe("resolvePackageRoot", () => {
  test("uses the configured asset root for a standalone executable", () => {
    expect(resolvePackageRoot("/$bunfs/root", "/app")).toBe(resolve("/app"));
  });

  test("defaults to the source package root when no override is configured", () => {
    expect(resolvePackageRoot("/workspace/src/config", undefined)).toBe(resolve("/workspace"));
  });
});
