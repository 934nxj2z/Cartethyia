import { expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { consoleLockouts, consoleUsers } from "../../src/persistence/schema";
import { resetConsoleAuthState } from "../../src/console/auth/account-reset-store";

test("console recovery atomically removes lockouts as well as users", async () => {
  const deletedTables: unknown[] = [];
  const transaction = {
    delete(table: unknown) {
      deletedTables.push(table);
      return Promise.resolve({ rowCount: table === consoleUsers ? 2 : 5 });
    },
  };
  const db = {
    transaction: async <T>(run: (tx: typeof transaction) => Promise<T>) => run(transaction),
  } as unknown as CartethyiaDatabase;

  const removedUsers = await resetConsoleAuthState(db);

  expect(deletedTables).toEqual([consoleLockouts, consoleUsers]);
  expect(removedUsers).toBe(2);
});
