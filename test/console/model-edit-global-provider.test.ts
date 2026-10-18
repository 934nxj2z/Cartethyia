/**
 * A model the console auto-fetched onto a *bundled* provider must be editable.
 *
 * Bundled providers are seeded once as global rows (`tenant_id IS NULL`) and
 * `providers.id` is the primary key, so there is no tenant-scoped row to edit
 * instead. `updateModelMetadata` used to filter on `ownedByOnly`, which matches
 * only `tenant_id = <tenant>`, so every fetched row on a bundled provider
 * answered `model_not_found` — the operator saw "Failed to update model: Model
 * … not found" for a row the console had just shown them.
 *
 * Two properties are pinned here, because the fix must not widen write access
 * beyond the case it was written for:
 *   - a `discovered`/`auto_free` row under a global provider is writable;
 *   - a `builtin` row under a global provider still is not (the bundle
 *     re-seeds it on every boot, so an edit would be silently reverted).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providers, tenants } from "../../src/persistence/schema";
import { DrizzleProviderCatalogStore } from "../../src/console/providers/catalog/store";
import { ProviderRegistry } from "../../src/providers/provider-registry";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

function buildStore(db: ReturnType<typeof buildSqliteHandle>["db"]): DrizzleProviderCatalogStore {
  return new DrizzleProviderCatalogStore(db, {
    telemetryBuffer: { enqueue() {} } as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: new ProviderRegistry(),
    outboundFetchFor: () => fetch,
    snapshotInvalidator: { invalidate() {} },
  });
}

/** One temp SQLite database with a tenant and a global bundled provider. */
async function withFixture(
  run: (ctx: {
    readonly store: DrizzleProviderCatalogStore;
    readonly db: ReturnType<typeof buildSqliteHandle>["db"];
    readonly tenantId: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-model-edit-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const db = buildSqliteHandle(sqlite).db;
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Operator", status: "active" });
    // The bundled-provider shape: one global row, `tenant_id` left NULL.
    await db.insert(providers).values({ id: "opencode" });
    await db.insert(models).values([
      {
        providerId: "opencode",
        modelId: "fetched-model",
        wireFamily: "chat",
        endpointPath: "/zen/v1/chat/completions",
        source: "auto_free",
        contextLimit: 200_000,
        outputLimit: 64_000,
      },
      {
        providerId: "opencode",
        modelId: "builtin-model",
        wireFamily: "chat",
        endpointPath: "/zen/v1/chat/completions",
        source: "builtin",
      },
    ]);
    await run({ store: buildStore(db), db, tenantId });
  } finally {
    sqlite.close();
    removeDir(dir);
  }
}

test("a fetched model on a global provider is editable", async () => {
  await withFixture(async ({ store, db, tenantId }) => {
    const ok = await store.updateModelMetadata(tenantId, "opencode", {
      modelId: "fetched-model",
      route: "/zen/v1/chat/completions",
      enabled: true,
      metadata: { contextLimit: 131_072, outputLimit: 32_768, reasoning: true },
    });
    expect(ok).toBe(true);

    const rows = await db
      .select()
      .from(models)
      .where(and(eq(models.providerId, "opencode"), eq(models.modelId, "fetched-model")));
    const row = rows[0];
    expect(row?.contextLimit).toBe(131_072);
    expect(row?.outputLimit).toBe(32_768);
    expect(row?.reasoning).toBe(true);
  });
});

test("a built-in model on a global provider is still refused", async () => {
  await withFixture(async ({ store, tenantId }) => {
    await expect(
      store.updateModelMetadata(tenantId, "opencode", {
        modelId: "builtin-model",
        route: "/zen/v1/chat/completions",
        enabled: true,
        metadata: { contextLimit: 1 },
      }),
    ).rejects.toThrow(/cannot be edited/);
  });
});

test("an unknown model still answers false", async () => {
  await withFixture(async ({ store, tenantId }) => {
    const ok = await store.updateModelMetadata(tenantId, "opencode", {
      modelId: "never-existed",
      route: "/zen/v1/chat/completions",
      enabled: true,
      metadata: { contextLimit: 1 },
    });
    expect(ok).toBe(false);
  });
});
