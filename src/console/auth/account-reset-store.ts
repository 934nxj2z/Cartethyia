import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { consoleLockouts, consoleUsers } from "../../persistence/schema";

/**
 * Clears console lockouts and accounts atomically so a reset can be followed
 * immediately by first-boot setup from the same client address.
 */
export function resetConsoleAuthState(db: CartethyiaDatabase): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(consoleLockouts);
    const users = await tx.delete(consoleUsers);
    return users.rowCount ?? 0;
  });
}
