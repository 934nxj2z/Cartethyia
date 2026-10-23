import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { payloadDirectory, prunePayloadFrames } from "../../observability/payload-store";
import type {
  DiskUsageBucket,
  DiskUsageResponse,
  PurgeTarget,
  ReclaimAction,
  ReclaimResponse,
} from "./contracts";
import { PurgeNotWiredError, ReclaimNotAllowedError } from "./contracts";

/**
 * Reads and reclaims the on-disk telemetry and payload directories, and
 * purges the health & error log — the console's one row-level deletion.
 *
 * Reclaiming files is safe because the data is already past the point the
 * gateway would read it: payload frames expire minutes after they are written,
 * and telemetry past the retention window sits outside every query's scan
 * bound. The health & error log purge is the deliberate exception: the rows are
 * an operator's diagnostic trail that no request-path code reads, so clearing
 * them costs nothing but the history itself.
 *
 * The telemetry directory is injected rather than read from its module
 * constant so the scanner can be pointed at a fixture. The payload directory
 * is not: reclaim goes through `prunePayloadFrames`, which resolves the
 * directory itself, and a second path would let the two drift so the scanner
 * measured one place while the prune emptied another. The health-event store
 * hook is injected for the same reason: this module should know its numbers,
 * not how storage reaches them.
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
  /**
   * The health & error log store, backing the console's only row-level purge.
   * Absent (a reduced console composition) means the purge is not offered
   * rather than failing to boot.
   */
  readonly healthEvents?:
    | {
        count(): Promise<number>;
        purgeAll(): Promise<number>;
      }
    | undefined;
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

const isIndex = (name: string): boolean => name.endsWith(".index.json");
const isHourly = (name: string): boolean => name.endsWith(".events.jsonl");
// Both extensions: old `.jsonb` files are still on disk and still counted.
const isFrame = (name: string): boolean =>
  name.endsWith(".jsonl") || name.endsWith(".jsonb");

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

    const [hourly, compacted, staleCompacted, frames, staleFrames, healthEventCount] = await Promise.all([
      scan(config.telemetryDir, isHourly),
      scan(config.telemetryDir, isIndex),
      scan(config.telemetryDir, (name) => isIndex(name) && dayBefore(name, retentionCutoff)),
      scan(payloadDir(), isFrame),
      scan(payloadDir(), isFrame, payloadCutoff),
      config.healthEvents?.count(),
    ]);

    const buckets: DiskUsageBucket[] = [
      {
        id: "telemetry_hourly",
        label: "Daily request files",
        bytes: hourly.bytes,
        files: hourly.files,
        note: "Feeds the request list and detail drawer.",
        reclaimableBytes: null,
        reclaimableFiles: null,
      },
      {
        id: "telemetry_compacted",
        label: "Day indexes",
        bytes: compacted.bytes,
        files: compacted.files,
        note: "Feeds usage totals, breakdowns and the chart.",
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
      ...(healthEventCount === undefined ? {} : { healthEventCount }),
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
      // Only day indexes past retention, and only together with their events.
      // Deleting one without the other is the failure this avoids: an index
      // with no events reports totals for requests that are gone.
      const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60_000;
      return unlinkWhere(action, config.telemetryDir, (name) =>
        (isIndex(name) || isHourly(name)) && dayBefore(name, cutoff),
      );
    }
    if (!config.allowHourlyReclaim) {
      throw new ReclaimNotAllowedError(
        "Hourly files are the only copy of their requests until compaction folds them up, so the console will not delete them.",
      );
    }
    return unlinkWhere(action, config.telemetryDir, isHourly);
  }

  /** The one row-level deletion the console offers. */
  async function purge(target: PurgeTarget): Promise<number> {
    switch (target) {
      case "health_events": {
        const store = config.healthEvents;
        if (store === undefined) throw new PurgeNotWiredError();
        return await store.purgeAll();
      }
    }
  }

  return { usage, reclaim, purge };
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
