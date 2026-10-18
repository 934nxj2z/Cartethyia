/**
 * Operator backup export: `POST /admin/export-backup`.
 *
 * Why an endpoint instead of the console page. The dashboard export requires
 * the operator's console password, because the browser session is the only
 * proof of identity it has. The CLI is already running as the OS user who owns
 * the config directory and the database, so requiring a password there only
 * means a forgotten password blocks the backup that is supposed to rescue the
 * install. This route is gated like the drain and reset routes — loopback peer
 * plus the constant-time token — and needs no password.
 *
 * What it writes: a gzipped JSON backup of the `config` section only.
 * `telemetry_events`, `telemetry_usage_totals`, and `telemetry_payloads` are
 * deliberately excluded: they are per-request history, not configuration, they
 * are the bulk of the file, and restoring them is not part of what an operator
 * is trying to recover.
 *
 * Where it lands: the directory the caller names, defaulting to the OS download
 * directory. The CLI passes that path; the route refuses to write outside it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayError } from "../../protocol/gateway-error";
import { isLoopbackPeer, tokenMatches } from "../../transport/drain-endpoint";
import { BACKUP_SECTIONS, tablesForSection } from "./contracts";
import { exportBackup } from "./store";
import type { CartethyiaDatabase } from "../../persistence/db-handle";

export interface BackupExportDeps {
  readonly db: CartethyiaDatabase;
  /** Shared secret; the route is registered only when this is set. */
  readonly token: string;
  /** The tenant whose rows are exported. */
  readonly resolveTenantId: () => Promise<string | null>;
  /** Peer address of the request, resolved by the composition root. */
  readonly resolvePeerAddress: (request: Request) => string | null;
}

export interface BackupExportResult {
  readonly path: string;
  readonly bytes: number;
  readonly counts: Record<string, number>;
}

export function createBackupExportHandler(
  deps: BackupExportDeps,
): (context: { request: Request; body: unknown }) => Promise<Response> {
  return async ({ request, body }) => {
    if (!isLoopbackPeer(deps.resolvePeerAddress(request)))
      throw new GatewayError("invalid_request", 403, "backup export is only available from loopback");
    if (!tokenMatches(request.headers.get("x-drain-token"), deps.token))
      throw new GatewayError("invalid_request", 401, "invalid export token");

    const directory =
      body !== null && typeof body === "object" && "directory" in body
        ? body.directory
        : undefined;
    if (directory !== undefined && typeof directory !== "string")
      throw new GatewayError("invalid_request", 400, "directory must be a string");

    const tenantId = await deps.resolveTenantId();
    if (tenantId === null)
      throw new GatewayError("invalid_request", 409, "no tenant exists; run setup first");

    const { payload, counts } = await exportBackup(
      deps.db,
      tablesForSection("config"),
      tenantId,
    );

    // gzipSync matches what the console writes, so a CLI backup and a dashboard
    // backup are the same file format and either can be restored by the other.
    const json = JSON.stringify(payload);
    const gzipped = Bun.gzipSync(new TextEncoder().encode(json));
    const target = directory ?? downloadDirectory();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(target, `cartethyia-backup-${stamp}.json.gz`);

    try {
      mkdirSync(target, { recursive: true });
      writeFileSync(path, gzipped);
    } catch (error) {
      throw new GatewayError(
        "invalid_request",
        500,
        `could not write ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    const result: BackupExportResult = { path, bytes: gzipped.byteLength, counts };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
}

/** The OS download directory, falling back to the home directory. */
function downloadDirectory(): string {
  const home = homedir();
  const candidate =
    process.platform === "win32"
      ? join(home, "Downloads")
      : process.platform === "darwin"
        ? join(home, "Downloads")
        : join(process.env.XDG_DOWNLOAD_DIR ?? join(home, "Downloads"));
  return candidate;
}

export { BACKUP_SECTIONS };
