import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { memoryNotifications, createUpdateRoutes } from "../../src/console/updates/routes";
import type { ObservabilityStore } from "../../src/console/observability/contracts";

test("memory watcher warns on sustained RSS growth and suppresses duplicate alerts", () => {
  const samples = [
    { at: 0, rss: 100, percent: 40 },
    { at: 20_000, rss: 108, percent: 42 },
    { at: 40_000, rss: 116, percent: 44 },
    { at: 60_000, rss: 125, percent: 46 },
  ];

  const first = memoryNotifications(samples, { high: false, growth: false });
  expect(first.notifications.map((item) => item.kind)).toEqual(["memory-growth"]);
  expect(memoryNotifications(samples, { high: false, growth: first.growth }).notifications).toEqual([]);
});

test("memory watcher warns once at high RSS and clears below its hysteresis floor", () => {
  const high = memoryNotifications(
    [{ at: 1_000, rss: 900, percent: 86 }],
    { high: false, growth: false },
  );
  expect(high.notifications.map((item) => item.kind)).toEqual(["memory-high"]);
  expect(memoryNotifications(
    [{ at: 2_000, rss: 910, percent: 83 }],
    { high: high.high, growth: false },
  ).notifications).toEqual([]);
  const recovered = memoryNotifications(
    [{ at: 3_000, rss: 700, percent: 79 }],
    { high: true, growth: false },
  );
  expect(recovered.high).toBe(false);
  expect(recovered.notifications).toEqual([]);
});

test("notification stream sends its initial server-measured memory alert", async () => {
  const app = new Elysia().use(createUpdateRoutes({
    accessResolver: () => ({
      id: "operator",
      tenantId: "tenant-1",
      admissionIdentity: "operator",
      scopes: ["dashboard:read"],
    }),
    observabilityStore: {
      health: async () => ({
        value: {
          memory_bytes: 900,
          memory_percent: 90,
          version: "1.0.0",
        },
      }),
      // The watcher reads memory fresh rather than through the cached health
      // read, so the stub has to answer the method it actually calls.
      liveMemory: async () => ({
        memory_bytes: 900,
        memory_percent: 90,
      }),
    } as unknown as ObservabilityStore,
    fetchRelease: async () => null,
  }));

  const response = await app.handle(
    new Request("http://localhost/notifications/stream", {
      signal: AbortSignal.timeout(2_000),
    }),
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("notification stream has no body");
  const first = await reader.read();
  const frame = new TextDecoder().decode(first.value);
  expect(frame).toContain('event: notification');
  expect(frame).toContain('"kind":"memory-high"');
  await reader.cancel();
});

test("the memory watcher samples live memory, not the cached health read", async () => {
  const app = new Elysia().use(createUpdateRoutes({
    accessResolver: () => ({
      id: "operator",
      tenantId: "tenant-1",
      admissionIdentity: "operator",
      scopes: ["dashboard:read"],
    }),
    observabilityStore: {
      health: async () => ({
        value: { memory_bytes: 900, memory_percent: 90, version: "1.0.0" },
      }),
      liveMemory: async () => ({ memory_bytes: 1_000, memory_percent: 12.5 }),
    } as unknown as ObservabilityStore,
    fetchRelease: async () => null,
  }));

  const response = await app.handle(
    new Request("http://localhost/notifications/stream", {
      signal: AbortSignal.timeout(2_000),
    }),
  );
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("notification stream has no body");
  const first = await reader.read();
  const frame = new TextDecoder().decode(first.value);
  // The cached read says 90%; the live one says 12.5%. An alert here means the
  // watcher is still reading stale bytes, which is the defect being pinned.
  expect(frame).not.toContain('"kind":"memory-high"');
  await reader.cancel();
});
