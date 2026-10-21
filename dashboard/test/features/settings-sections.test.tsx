/**
 * Settings page contract: every section is on the page at once.
 *
 * The property worth pinning is that no setting is hidden behind a tab or a
 * disclosure — the page used to show one section at a time, so an operator
 * hunting for a setting had to know which heading concealed it. Now the whole
 * surface renders, so a control that quietly moved behind a selector shows up
 * here as a failure.
 *
 * Also pinned: no nested cards, and no tab markup left behind. The page used to
 * render a card inside a card, doubling borders and padding, which only shows
 * up visually.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import Settings from "../../src/features/settings/SettingsPage";
import { mount, stubFetch } from "../helpers/render";
import { registerDom } from "../helpers/dom";

/**
 * Radix's Select touches `HTMLFormElement` while wiring its hidden form
 * field, and happy-dom does not put that constructor on `globalThis` — only
 * on `window`. Mounting a real Select therefore needs it aliased first, or the
 * component throws before it renders.
 *
 * This runs in `beforeAll` rather than at module scope: Bun shares one process
 * across test files, so importing a DOM at module load leaks it into sibling
 * suites that expect a bare environment.
 */
beforeAll(() => {
registerDom();
  // happy-dom installs its constructors on `window` but not on `globalThis`,
  // and Radix reaches for them unqualified — `HTMLFormElement`, then
  // `DocumentFragment`, then whatever it touches next. Alias every missing
  // window property rather than guessing a prefix: patching the one name in
  // the current error just moves the failure along.
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    // Some window properties are read-only accessors, so a plain assignment
    // throws; define them instead and skip the few that cannot be redefined.
    try {
      Object.defineProperty(target, name, {
        value,
        writable: true,
        configurable: true,
      });
    } catch {
      // Not aliasing this one is fine: it either already works or is unused.
    }
  }
});

const SETTINGS = {
  telemetryPayloads: "none",
  telemetryPayloadDepth: "minimum",
  privacyMode: "masked",
  forceDisableCooldown: false,
  upstreamTimeoutSeconds: null,
  telemetryCompactAfterDays: null,
  imageClampMaxBytes: null,
};

async function mountSettings() {
  // The hook requests "/settings/runtime", which `consoleRequest` prefixes to
  // "/console/api/settings/runtime". The match is method-qualified because
  // `stubFetch` skips a route whose `match` does not contain the request
  // method, so a bare path never answers a GET.
  const stub = stubFetch([
    { match: "GET /console/api/settings/runtime", json: SETTINGS },
  ]);
  const mounted = await mount(createElement(Settings));
  // The privacy and operations panels show a loading state until their query
  // settles, so assertions run after the flush rather than against a skeleton.
  await mounted.flush();
  await mounted.flush();
  return { ...mounted, restore: stub.restore };
}

describe("Settings sections", () => {
  test("all four sections render at once", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      const titles = Array.from(container.querySelectorAll("section > h2")).map(
        (h) => h.textContent,
      );
      expect(titles).toEqual(["Security", "Privacy", "Operations", "Data"]);
    } finally {
      unmount();
      restore();
    }
  });

  test("every section's controls are reachable without selecting anything", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      // One control per section: if any of these is missing, that section is
      // hidden behind a selector again.
      for (const id of [
        "current-password", // Security
        "privacy-payloads", // Privacy
        "image-clamp-max-bytes", // Operations
      ]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
      // Data's control has no id of its own; assert the section exists and is
      // populated rather than reaching for a button label that may change.
      const data = container.querySelector("#data");
      expect(data).not.toBeNull();
      expect(data?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("nothing is behind a tab", async () => {
    // Guards against a tab strip creeping back in: role=tab would mean one
    // section is visible and the rest are hidden again.
    const { container, unmount, restore } = await mountSettings();
    try {
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("no card is nested inside another card", async () => {
    // Doubles the border and the padding; caught only by looking.
    const { container, unmount, restore } = await mountSettings();
    try {
      expect(container.querySelectorAll(".card .card")).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("each section is still deep-linkable", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      for (const id of ["security", "privacy", "operations", "data"]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
    } finally {
      unmount();
      restore();
    }
  });
});
