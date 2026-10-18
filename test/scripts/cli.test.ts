/**
 * The CLI pieces that broke in the 2.3.x line, pinned.
 *
 * `chooseFromMenu` returns -1 when stdin is not a TTY, which is what a piped or
 * CI run hits; without that guard a menu blocks forever on input that never
 * arrives. The drain token is what lets `cartethyia stop` reach a gateway it did
 * not start — it has to be stable across runs, because a token regenerated per
 * start can never match the gateway that is actually running.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseFromMenu } from "../../scripts/cli/menu";
import { ensureDrainToken, readPersistedDrainToken } from "../../scripts/cli/runtime-state";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cartethyia-cli-test-"));
  originalConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

test("chooseFromMenu returns -1 when stdin is not a TTY", () => {
  // Under `bun test` stdin is not a TTY, so this is the real non-interactive
  // path rather than a mock: the menu must not block waiting for a keypress.
  expect(
    chooseFromMenu("title", [
      { kind: "action", label: "a" },
      { kind: "action", label: "b" },
    ]),
  ).resolves.toBe(-1);
});

test("the drain token is stable across calls and persisted", () => {
  expect(readPersistedDrainToken()).toBeNull();
  const first = ensureDrainToken();
  expect(first.length).toBeGreaterThan(0);
  // A second call must return the same token: `stop` in another process reads
  // this file, and a new token per start could never authenticate.
  expect(ensureDrainToken()).toBe(first);
  expect(readPersistedDrainToken()).toBe(first);
});

test("a corrupt runtime state file reads as no token and is replaced", () => {
  writeFileSync(join(configDir, "runtime.json"), "{ not json", "utf8");
  expect(readPersistedDrainToken()).toBeNull();
  const token = ensureDrainToken();
  expect(token.length).toBeGreaterThan(0);
  expect(readPersistedDrainToken()).toBe(token);
});
