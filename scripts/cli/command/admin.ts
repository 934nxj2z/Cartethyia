/**
 * The two admin actions the menu and the tray both offer.
 *
 * Both go through the running gateway rather than the database file: the
 * gateway holds the connection and the schema is dialect-dependent, so reading
 * or writing the tables from this process would need a second implementation
 * of both.
 */

/**
 * Asks the gateway to write a gzipped config backup into the download
 * directory. Returns the written path and counts, or null when it failed.
 */
export async function exportBackup(
  port: number,
  token: string,
): Promise<{ path: string; bytes: number; counts: Record<string, number> } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/export-backup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the backup (HTTP ${response.status}). ${detail}`.trim());
      return null;
    }
    return (await response.json()) as {
      path: string;
      bytes: number;
      counts: Record<string, number>;
    };
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return null;
  }
}

/**
 * Posts the console-account reset to the running gateway.
 *
 * Returns 0 on success and 1 on any failure so the caller can print one line
 * either way.
 */
export async function resetConsoleAccount(port: number, token: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/reset-console-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({ confirm: "RESET" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the reset (HTTP ${response.status}). ${detail}`.trim());
      return 1;
    }
    return 0;
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return 1;
  }
}
