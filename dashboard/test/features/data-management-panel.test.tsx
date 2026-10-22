/**
 * Contract tests for the Data Management panel.
 *
 * The properties worth pinning are the safety ones, because a panel that
 * offers the wrong button is a data-loss waiting to happen: hourly files get
 * no reclaim at all (they are the only copy of their requests), and a bucket
 * with nothing reclaimable must not offer a button that would do nothing —
 * which reads as broken rather than as "already clean".
 *
 * Both are asserted on rendered markup rather than computed layout, which a
 * test DOM has none of.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { DataManagementPanel } from "../../src/features/settings/DataManagementPanel";
import { mount, stubFetch } from "../helpers/render";
import { registerDom } from "../helpers/dom";

beforeAll(() => {
  // Radix reaches for DOM constructors unqualified, and happy-dom installs
  // them on `window` rather than `globalThis`.
  registerDom();
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    } catch {
      // Not aliasing this one is fine.
    }
  }
});

const USAGE = {
  totalBytes: 3 * 1024 * 1024,
  retentionDays: 30,
  payloadRetentionMs: 15 * 60_000,
  buckets: [
    {
      id: "telemetry_hourly",
      label: "Hourly request files",
      bytes: 2 * 1024 * 1024,
      files: 24,
      note: "Per-request records.",
      reclaimableBytes: null,
      reclaimableFiles: null,
    },
    {
      id: "telemetry_compacted",
      label: "Daily summaries",
      bytes: 1024 * 1024,
      files: 30,
      note: "Already folded up.",
      reclaimableBytes: 512 * 1024,
      reclaimableFiles: 5,
    },
    {
      id: "payload_frames",
      label: "Payload frames",
      bytes: 4096,
      files: 2,
      note: "Captured bodies.",
      reclaimableBytes: 0,
      reclaimableFiles: 0,
    },
  ],
};

async function mountPanel() {
  const stub = stubFetch([
    { match: "GET /console/api/data-management/usage", json: USAGE },
  ]);
  const mounted = await mount(createElement(DataManagementPanel));
  await mounted.flush();
  await mounted.flush();
  return { ...mounted, restore: stub.restore, calls: stub.calls };
}

describe("DataManagementPanel", () => {
  test("shows each bucket with its size", async () => {
    const { container, unmount, restore } = await mountPanel();
    try {
      const text = container.textContent ?? "";
      // 2 MiB and 1 MiB are the two large buckets; formatting comes from the
      // shared helper, so assert on the rendered figure rather than raw bytes.
      expect(text).toContain("Hourly request files");
      expect(text).toContain("Daily summaries");
      expect(text).toContain("Payload frames");
      // `formatBytes` scales to KB/MB with one decimal, not MiB.
      expect(text).toContain("2.0 MB");
      expect(text).toContain("1.0 MB");
    } finally {
      unmount();
      restore();
    }
  });

  test("hourly files get no reclaim button", async () => {
    // The safety boundary. An hourly file is the only copy of its requests
    // until compaction folds it up, so the panel must not offer to delete it.
    const { container, unmount, restore } = await mountPanel();
    try {
      const row = container.querySelector('[data-bucket="telemetry_hourly"]');
      expect(row).not.toBeNull();
      expect(row?.querySelectorAll("button")).toHaveLength(0);
      expect(row?.textContent).toContain("no other copy");
    } finally {
      unmount();
      restore();
    }
  });

  test("a bucket with nothing reclaimable shows why, not a dead button", async () => {
    const { container, unmount, restore } = await mountPanel();
    try {
      const row = container.querySelector('[data-bucket="payload_frames"]');
      expect(row?.textContent).toContain("Clean");
      // A button that would delete nothing reads as broken.
      const buttons = Array.from(row?.querySelectorAll("button") ?? []);
      expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    } finally {
      unmount();
      restore();
    }
  });

  test("a bucket with something reclaimable offers it", async () => {
    const { container, unmount, restore } = await mountPanel();
    try {
      const row = container.querySelector('[data-bucket="telemetry_compacted"]');
      expect(row?.textContent).toContain("512.0 KB");
      const button = Array.from(row?.querySelectorAll("button") ?? []).find(
        (b) => (b.textContent ?? "").includes("Reclaim"),
      ) as HTMLButtonElement | undefined;
      expect(button).not.toBeUndefined();
      expect(button?.disabled).toBe(false);
    } finally {
      unmount();
      restore();
    }
  });

  test("flush is offered and is never a delete", async () => {
    const { container, unmount, restore } = await mountPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Flush pending writes");
      // The reassurance matters next to two delete buttons on the same panel.
      expect(text).toContain("Nothing is deleted");
    } finally {
      unmount();
      restore();
    }
  });

  test("the buckets sit in one grid so they can be compared", async () => {
    // Side by side rather than stacked: three rows of prose force the reader
    // to hold one number in their head while looking at the next.
    const { container, unmount, restore } = await mountPanel();
    try {
      const cards = container.querySelectorAll("[data-bucket]");
      expect(cards).toHaveLength(3);
      const parents = new Set(Array.from(cards).map((c) => c.parentElement));
      expect(parents.size).toBe(1);
      const grid = cards[0]?.parentElement;
      expect(grid?.className).toContain("grid-cols-3");
      // Collapses on narrow screens, where three columns would be unreadable.
      expect(grid?.className).toContain("max-medium:grid-cols-1");
    } finally {
      unmount();
      restore();
    }
  });
});
