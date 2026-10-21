/**
 * API-key scopes must survive an update.
 *
 * The PATCH route validated `scopes` and handed them to the store, but the
 * store built its `set({...})` from an explicit field allowlist that never
 * listed `scopes` — so the value was type-checked, accepted, and dropped. Two
 * symptoms came out of one hole: the CLI-tools page's "Remote Routing" toggle
 * appeared to save and the badge stayed "no CLI scope", and an allow-set edit
 * reported success while changing nothing.
 *
 * The gap was silent because nothing asserted the round trip; this suite is
 * that assertion.
 */
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as fullSchema from "../../src/persistence/schema";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { createRunId, dbDescribe, requireDatabase, withRollback } from "../helpers/database";
import { createApiKey, createTenant } from "../helpers/fixtures";

requireDatabase();

const RUN_ID = createRunId("api-key-scopes");

dbDescribe("API key scopes persistence", () => {
  test("an update persists the granted scopes", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: "cli mapping key",
        scopes: ["routing:invoke"],
      });

      const store = new DrizzleApiKeyStore(drizzle(client as never, { schema: fullSchema }) as never);

      const updated = await store.update(tenant.tenantId, key.id, {
        scopes: ["routing:invoke", "routing:cli_mapping"],
      });
      expect(updated).toBeDefined();
      expect(updated?.scopes).toContain("routing:cli_mapping");

      // Read back through the store's own mapper, not the update's return:
      // the row is what the auth snapshot is built from on the next request.
      const reread = await store.get(tenant.tenantId, key.id);
      expect(reread?.scopes).toEqual(["routing:invoke", "routing:cli_mapping"]);
    });
  });

  test("a patch without scopes leaves the existing grant alone", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: "untouched key",
        scopes: ["routing:invoke", "routing:cli_mapping"],
      });

      const store = new DrizzleApiKeyStore(drizzle(client as never, { schema: fullSchema }) as never);
      await store.update(tenant.tenantId, key.id, { label: "renamed key" });

      const reread = await store.get(tenant.tenantId, key.id);
      expect(reread?.label).toBe("renamed key");
      expect(reread?.scopes).toEqual(["routing:invoke", "routing:cli_mapping"]);
    });
  });

  test("an empty scope list is persisted as no scopes", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const key = await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: "revoked scope key",
        scopes: ["routing:invoke", "routing:cli_mapping"],
      });

      const store = new DrizzleApiKeyStore(drizzle(client as never, { schema: fullSchema }) as never);
      // Validation rejects unknown scope strings, not an empty list, so `[]`
      // is reachable and means "no scopes" — it must narrow, not no-op.
      await store.update(tenant.tenantId, key.id, { scopes: [] });

      const reread = await store.get(tenant.tenantId, key.id);
      expect(reread?.scopes).toEqual([]);
    });
  });
});
