/**
 * Settings page contract: it is tabbed, and only one section is mounted.
 *
 * The property worth pinning is that switching tabs changes what is mounted —
 * an earlier revision passed all four panels as children, so every panel
 * mounted at once. That cost four sets of form state and fired every panel's
 * query on page load, and it is invisible in review because the markup looks
 * right either way.
 *
 * Also pinned: no nested cards. The page used to render a card inside a card,
 * doubling borders and padding, which only shows up visually.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import Settings from "../../src/features/settings/SettingsPage";
import { mount, stubFetch } from "../helpers/render";

const SETTINGS = {
  telemetryPayloads: "none",
  telemetryPayloadDepth: "minimum",
  privacyMode: "masked",
  forceDisableCooldown: false,
  upstreamTimeoutSeconds: null,
  telemetryCompactAfterDays: null,
  imageClampMaxBytes: null,
};

const LABELS = ["Security", "Privacy", "Operations", "Data"];

async function mountSettings() {
  const stub = stubFetch([{ match: "runtime-settings", json: SETTINGS }]);
  const mounted = await mount(createElement(Settings));
  return {
    ...mounted,
    restore: stub.restore,
    tabs: () => Array.from(mounted.container.querySelectorAll<HTMLElement>('[role="tab"]')),
  };
}

describe("Settings tabs", () => {
  test("all four sections are offered and Security opens first", async () => {
    const { container, tabs, unmount, restore } = await mountSettings();
    try {
      expect(tabs().map((t) => t.textContent?.trim())).toEqual(LABELS);
      const selected = tabs().filter((t) => t.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      expect(selected[0]?.textContent?.trim()).toContain("Security");
      // The password form is the Security panel's content.
      expect(container.querySelector("#current-password")).not.toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  test("only the selected section is mounted", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      // One panel, not four: each panel owns a query, and mounting them all
      // would fire every request when the page opens.
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(container.querySelector("#current-password")).not.toBeNull();
      // Privacy's control must not be mounted while Security is selected.
      expect(container.querySelector("#privacy-payloads")).toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  test("choosing a tab swaps the mounted section", async () => {
    const { container, tabs, act, unmount, restore } = await mountSettings();
    try {
      await act(() => {
        tabs()[2]?.click();
      });
      expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
      expect(container.querySelector("[role=tabpanel] h2")?.textContent).toBe("Operations");
      // The previous panel is gone rather than hidden behind it.
      expect(container.querySelector("#current-password")).toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  test("no card is nested inside another card", async () => {
    // Doubles the border and the padding; caught only by looking.
    const { container, act, tabs, unmount, restore } = await mountSettings();
    try {
      expect(container.querySelectorAll(".card .card")).toHaveLength(0);
      await act(() => {
        tabs()[3]?.click();
      });
      expect(container.querySelectorAll(".card .card")).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });
});
