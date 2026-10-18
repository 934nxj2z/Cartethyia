import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import { BackupService } from "../../src/console/backup/service";
import { providerAccounts } from "../../src/persistence/schema";
import {
  decryptCredentialToString,
  encryptCredential,
  setCredentialEncryptionKeyForTesting,
  snapshotCredentialEncryptionKeyForTesting,
} from "../../src/security/crypto";
import { seedBundledProviders } from "../../src/providers/operations/provider-catalog-service";

test("restores legacy sealed credentials with the active encryption key", async () => {
  const previousKey = snapshotCredentialEncryptionKeyForTesting();
  const key = randomBytes(32);
  setCredentialEncryptionKeyForTesting(key);
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const ciphertext = encryptCredential("legacy-provider-token").toString("base64");
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    await seedBundledProviders(db);

    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("password", {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          tenants: [{ id: tenantId, name: "restored", status: "active" }],
          provider_accounts: [
            {
              id: accountId,
              provider_id: "openai",
              tenant_id: tenantId,
              label: "legacy account",
              credential_ciphertext: { __bytes: ciphertext },
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    }, tenantId);

    const [account] = await db.select().from(providerAccounts);
    expect(result.restored["provider_accounts"]).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(account).toBeDefined();
    if (account === undefined || account.credentialCiphertext === null) {
      throw new Error("restored account credential was not sealed");
    }
    expect(decryptCredentialToString(account.credentialCiphertext)).toBe("legacy-provider-token");
  } finally {
    sqlite.close();
    setCredentialEncryptionKeyForTesting(previousKey);
  }
});

test("skips routing settings for providers absent from the backup target", async () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("password", {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          provider_routing_settings: [
            { provider_id: "retired-provider", strategy: "fallback", rotate_count: 1 },
          ],
        },
      },
    }, randomUUID());

    expect(result.restored["provider_routing_settings"]).toBe(0);
    expect(result.warnings).toContainEqual({
      table: "provider_routing_settings",
      column: "provider_id",
      reason: "referenced a provider not available in this installation; those rows were skipped",
    });
  } finally {
    sqlite.close();
  }
});
