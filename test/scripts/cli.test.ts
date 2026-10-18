/**
 * The CLI pieces that broke in the 2.3.x line, pinned.
 *
 * `chooseFromMenu` returned its own resolution when stdin was not a TTY, which
 * is what a piped or CI run hits; without that guard a menu blocks forever on
 * input that never arrives. The drain-token trio is what lets `cartethyia
 * stop` reach a gateway left running by "Hide to background" — they are the
 * only handle on a process that is not a child of the stopping shell.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPersistedDrainToken,
  readPersistedDrainToken,
  writePersistedDrainToken,
} from "../../scripts/cli/runtime-state";
import { chooseFromMenu } from "../../scripts/cli/menu";

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
  expect(chooseFromMenu("title", ["a", "b"])).resolves.toBe(-1);
});

test("the drain token round-trips through the runtime state file", () => {
  expect(readPersistedDrainToken()).toBeNull();
  writePersistedDrainToken("token-under-test");
  expect(readPersistedDrainToken()).toBe("token-under-test");
  clearPersistedDrainToken();
  expect(readPersistedDrainToken()).toBeNull();
});

test("a corrupt runtime state file reads as no background gateway", () => {
  writeFileSync(join(configDir, "runtime.json"), "{ not json", "utf8");
  expect(readPersistedDrainToken()).toBeNull();
});
