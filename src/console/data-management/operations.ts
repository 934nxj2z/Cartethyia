import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { payloadDirectory, prunePayloadFrames } from "../../observability/payload-store";
import type {
  DiskUsageBucket,
  DiskUsageResponse,
  ReclaimAction,
  ReclaimResponse,
} from "./contracts";
import { ReclaimNotAllowedError } from "./contracts";

/**
 * Reads and reclaims the on-disk telemetry and payload directories.
 *
 * Everything here touches files, never database rows. Reclaiming is safe
 * because the data is already past the point the gateway would read it:
 * payload frames expire minutes after they are written, and telemetry past
 * the retention window sits outside every query's scan bound. Deleting rows
 * is a different decision with a different blast radius and is deliberately
 * not offered.
 *
 * The telemetry directory is injected rather than read from its module
 * constant so the scanner can be pointed at a fixture. The payload directory
 * is not: reclaim goes through `prunePayloadFrames`, which resolves the
 * directory itself, and a second path would let the two drift so the scanner
 * measured one place while the prune emptied another.
 */

export interface DataManagementConfig {
  readonly telemetryDir: string;
  readonly retentionDays: number;
  readonly payloadRetentionMs: number;
  /**
   * Whether hourly files may be dropped from the console. Off unless a caller
   * opts in: an hourly file still inside the compaction window is the only
   * copy of its requests, so removing one loses real history.
   */
  readonly allowHourlyReclaim: boolean;
}

interface Scan {
  readonly bytes: number;
  readonly files: number;
}

async function scan(
  directory: string,
  match: (name: string) => boolean,
  modifiedBefore?: number,
): Promise<Scan> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let bytes = 0;
  let files = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (modifiedBefore !== undefined && info.mtimeMs >= modifiedBefore) continue;
    bytes += info.size;
    files += 1;
  }
  return { bytes, files };
}

const isCompacted = (name: string): boolean => name.endsWith(".compacted.jsonl");
const isHourly = (name: string): boolean => name.endsWith(".jsonl") && !isCompacted(name);
const isFrame = (name: string): boolean => name.endsWith(".jsonb");

/** The UTC day a telemetry file name starts with, compared to a cutoff. */
function dayBefore(name: string, cutoff: number): boolean {
  const at = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(at) && at < cutoff;
}

export function createDataManagementOperations(config: DataManagementConfig) {
  const payloadDir = (): string => payloadDirectory();

  async function usage(): Promise<DiskUsageResponse> {
    const retentionCutoff = Date.now() - config.retentionDays * 24 * 60 * 60_000;
    const payloadCutoff = Date.now() - config.payloadRetentionMs;

    const [hourly, compacted, staleCompacted, frames, staleFrames] = await Promise.all([
      scan(config.telemetryDir, isHourly),
      scan(config.telemetryDir, isCompacted),
      scan(config.telemetryDir, (name) => isCompacted(name) && dayBefore(name, retentionCutoff)),
      scan(payloadDir(), isFrame),
      scan(payloadDir(), isFrame, payloadCutoff),
    ]);

    const buckets: DiskUsageBucket[] = [
      {
        id: "telemetry_hourly",
        label: "Hourly request files",
        bytes: hourly.bytes,
        files: hourly.files,
        note: "Feeds the request list and detail drawer.",
        reclaimableBytes: null,
        reclaimableFiles: null,
      },
      {
        id: "telemetry_compacted",
        label: "Daily summaries",
        bytes: compacted.bytes,
        files: compacted.files,
        note: `Feeds totals only. Past ${config.retentionDays} days, nothing reads them.`,
        reclaimableBytes: staleCompacted.bytes,
        reclaimableFiles: staleCompacted.files,
      },
      {
        id: "payload_frames",
        label: "Payload frames",
        bytes: frames.bytes,
        files: frames.files,
        note: `Captured bodies, expiring ${Math.round(
          config.payloadRetentionMs / 60_000,
        )} min after write.`,
        reclaimableBytes: staleFrames.bytes,
        reclaimableFiles: staleFrames.files,
      },
    ];

    return {
      buckets,
      totalBytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
      retentionDays: config.retentionDays,
      payloadRetentionMs: config.payloadRetentionMs,
    };
  }

  async function reclaim(action: ReclaimAction): Promise<ReclaimResponse> {
    if (action === "payload_frames") {
      // Delegated rather than reimplemented: frame expiry lives inside each
      // file, so a file's mtime alone cannot say whether it still holds a live
      // frame. Measuring around the call is how the bytes are reported without
      // duplicating that rule.
      const before = await scan(payloadDir(), isFrame);
      // `before` is the expiry bound: a frame still live at this instant is
      // kept. The second argument covers files that cannot be parsed — one
      // written after that bound might still hold a live frame in the part
      // that failed to parse, so it is left for a later pass.
      const now = new Date();
      const deletedFiles = await prunePayloadFrames(
        now,
        new Date(now.getTime() - config.payloadRetentionMs),
      );
      const after = await scan(payloadDir(), isFrame);
      return {
        action,
        deletedFiles,
        reclaimedBytes: Math.max(0, before.bytes - after.bytes),
      };
    }
    if (action === "telemetry_retention") {
      // Only summaries past retention. An hourly file that old would normally
      // have been compacted already, but excluding it here too means a
      // misconfigured compaction cannot turn this into data loss.
      const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60_000;
      return unlinkWhere(action, config.telemetryDir, (name) =>
        isCompacted(name) && dayBefore(name, cutoff),
      );
    }
    if (!config.allowHourlyReclaim) {
      throw new ReclaimNotAllowedError(
        "Hourly files are the only copy of their requests until compaction folds them up, so the console will not delete them.",
      );
    }
    return unlinkWhere(action, config.telemetryDir, isHourly);
  }

  return { usage, reclaim };
}

async function unlinkWhere(
  action: ReclaimAction,
  directory: string,
  match: (name: string) => boolean,
): Promise<ReclaimResponse> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let deletedFiles = 0;
  let reclaimedBytes = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(directory, name);
    // Measured before the unlink, since the size is gone afterwards.
    const size = await stat(path)
      .then((value) => value.size)
      .catch(() => 0);
    const removed = await unlink(path).then(
      () => true,
      () => false,
    );
    if (!removed) continue;
    deletedFiles += 1;
    reclaimedBytes += size;
  }
  // The response names the action, so a caller that fired two reclaims can
  // tell which result is which rather than both reading the same thing.
  return { action, deletedFiles, reclaimedBytes };
}
