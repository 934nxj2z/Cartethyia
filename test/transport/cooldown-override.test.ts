/**
 * `forceDisableCooldown` keeps a cooling account routable.
 *
 * The setting is dangerous on purpose, so what needs proving is not that it
 * works but that it works *only* in the narrow sense intended:
 *
 * - an account-wide cooldown stops excluding the candidate;
 * - the cooldown is still carried on the candidate, so `plan()` can still
 *   explain an all-cooling case with the real reset;
 * - the override is read-only — no account row is written, so turning it off
 *   needs no cleanup.
 *
 * The suite creates and cools **its own** account. Cooling every account in the
 * table would be simpler but would leave the fixture database altered for every
 * later test in the same worker, which is exactly how a suite starts passing or
 * failing depending on the order it ran in.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings, providerAccounts } from "../../src/persistence/schema";
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

/** A cooldown that has not elapsed: the account is genuinely parked. */
const FUTURE = new Date(Date.now() + 60 * 60_000);

dbDescribe("forceDisableCooldown", () => {
  let world: GatewayWorld;
  let accountId: string;

  beforeAll(async () => {
    world = await createWorld();
    accountId = await world.addAccount({
      tenantId: world.tenantId,
      credential: "sk-cooldown-override",
      credentialKind: "api_key",
    });
  });

  afterAll(async () => {
    // Restore the one row this suite touched, so the account is not left
    // cooling for whatever runs next in this worker.
    if (accountId !== undefined) {
      await getDb()
        .update(providerAccounts)
        .set({ status: "active", cooldownUntil: null })
        .where(eq(providerAccounts.id, accountId))
        .catch(() => undefined);
    }
    await world?.cleanup();
  });

  async function writePreferences(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  /** Puts this suite's own account into cooldown. */
  async function cool(): Promise<void> {
    await getDb()
      .update(providerAccounts)
      .set({
        status: "cooldown",
        cooldownUntil: FUTURE,
        lastErrorCategory: "rate_limit_transient",
      })
      .where(eq(providerAccounts.id, accountId));
  }

  /** The health of the candidate serving this suite's account. */
  async function candidateFor(): Promise<Record<string, unknown> | undefined> {
    const snapshot = (await createDatabaseSnapshotBuilder(getDb())()) as unknown as {
      readonly candidates?: readonly Record<string, unknown>[];
    };
    return (snapshot.candidates ?? []).find(
      (candidate) => candidate["provider_account_id"] === accountId,
    );
  }

  test("a cooled account is excluded by default", async () => {
    await writePreferences({});
    await cool();
    const candidate = await candidateFor();
    expect(candidate).toBeDefined();
    expect(candidate?.["health_status"]).toBe("cooldown");
  });

  test("with the override, the same account is no longer marked cooldown", async () => {
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    const candidate = await candidateFor();
    expect(candidate).toBeDefined();
    // The whole point: it is routable again.
    expect(candidate?.["health_status"]).not.toBe("cooldown");
  });

  test("the override still carries the reset so plan() can explain it", async () => {
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    // `cooldown_until` rides along even when the exclusion is skipped, so an
    // all-cooling answer can say when to retry instead of a bare 429.
    expect(await candidateFor().then((c) => c?.["cooldown_until"])).toBe(FUTURE.getTime());
  });

  test("the override is read-only — the account row still says cooldown", async () => {
    // Turning the setting off must need no cleanup, which is only true if
    // nothing was written back.
    await writePreferences({ forceDisableCooldown: true });
    await cool();
    await candidateFor();
    const rows = await getDb()
      .select({ status: providerAccounts.status })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(rows[0]?.status).toBe("cooldown");
  });
});
