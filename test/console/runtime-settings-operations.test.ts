/**
 * The operational settings: cooldown override, upstream timeout, compaction age.
 *
 * These are the knobs that used to be deployment-only env vars. Two properties
 * matter more than the values themselves:
 *
 * - **A dangerous default stays off.** `forceDisableCooldown` must survive a
 *   round trip as `false` when nothing was ever written — a stored preference
 *   bag that omits it is not consent to route around cooldowns.
 * - **A number outside the request path's range is clamped, not stored raw.**
 *   These override values are read while dispatching, so an out-of-range one
 *   would be a live footgun; clamping keeps them inside the range the
 *   deployment env var itself accepts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings } from "../../src/persistence/schema";
import { DrizzleRuntimeSettingsStore } from "../../src/console/settings/store";
import { resolveEffectiveWindowMinutes } from "../../src/observability/event-compaction";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

dbDescribe("operational runtime settings", () => {
  let world: GatewayWorld;
  let store: DrizzleRuntimeSettingsStore;

  beforeAll(async () => {
    world = await createWorld();
    store = new DrizzleRuntimeSettingsStore(getDb(), "redis");
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** Writes a raw preferences bag, exactly as the dashboard's PATCH leaves it. */
  async function writeBag(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  test("an unset cooldown override stays off", async () => {
    // The dangerous direction: absent must never read as enabled.
    await writeBag({});
    const settings = await store.get(world.tenantId);
    expect(settings.forceDisableCooldown).toBe(false);
  });

  test("a cooldown override round-trips", async () => {
    await writeBag({ forceDisableCooldown: true });
    expect((await store.get(world.tenantId)).forceDisableCooldown).toBe(true);
    await writeBag({ forceDisableCooldown: false });
    expect((await store.get(world.tenantId)).forceDisableCooldown).toBe(false);
  });

  test("an absent numeric override reads as null, not zero", async () => {
    // `null` means "use the deployment default"; zero would be a real (and
    // unusable) value. Conflating them would silently disable a timeout.
    await writeBag({});
    const settings = await store.get(world.tenantId);
    expect(settings.upstreamTimeoutSeconds).toBeNull();
    expect(settings.telemetryWindowMinutes).toBeNull();
  });

  test("an out-of-range timeout is clamped to the env var's own bounds", async () => {
    await writeBag({ upstreamTimeoutSeconds: 999_999 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBe(600);
    await writeBag({ upstreamTimeoutSeconds: 3 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBe(5);
  });

  test("a negative or non-numeric override reads as null", async () => {
    // Neither is a value the request path can honour, and neither should be
    // stored as one: they mean "no override".
    await writeBag({ upstreamTimeoutSeconds: -5 });
    expect((await store.get(world.tenantId)).upstreamTimeoutSeconds).toBeNull();
    await writeBag({ telemetryWindowMinutes: "not a number" });
    expect((await store.get(world.tenantId)).telemetryWindowMinutes).toBeNull();
  });

  test("a compaction age override round-trips", async () => {
    await writeBag({ telemetryWindowMinutes: 14 });
    expect((await store.get(world.tenantId)).telemetryWindowMinutes).toBe(14);
  });

  test("the effective compaction age never compacts earlier than the widest ask", async () => {
    // Hourly files hold every tenant together, so the safest reading of several
    // preferences is the largest: compacting earlier than one tenant asked for
    // destroys rows that tenant expected to keep, while compacting later only
    // costs disk.
    await writeBag({ telemetryWindowMinutes: 21 });
    const effective = await resolveEffectiveWindowMinutes(getDb());
    expect(effective).toBeGreaterThanOrEqual(21);
  });

  test("an attachment ceiling round-trips", async () => {
    await writeBag({ imageClampMaxBytes: 25 * 1024 * 1024 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(25 * 1024 * 1024);
  });

  test("an attachment ceiling is clamped to what the clamp can honour", async () => {
    // 64 KB floor, 100 MB ceiling: outside that the value would either admit
    // nothing usable or promise more than any upstream takes.
    await writeBag({ imageClampMaxBytes: 1 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(64 * 1024);
    await writeBag({ imageClampMaxBytes: 500 * 1024 * 1024 });
    expect((await store.get(world.tenantId)).imageClampMaxBytes).toBe(100 * 1024 * 1024);
  });
});
