/**
 * Disk housekeeping: what the telemetry and payload directories hold, and the
 * reclaim actions an operator can run from the console.
 *
 * Everything here is files on disk, never database rows. Reclaiming a file is
 * safe because the data it held is already past the point where the gateway
 * would read it: payload frames expire 15 minutes after they are written, and
 * telemetry files past the retention window are outside every query's scan
 * bound. Deleting rows is a different decision with a different blast radius,
 * and is deliberately not offered here.
 *
 * Sizes are bytes as `number`. A directory is scanned on each read rather than
 * cached, because the point of the panel is to show what is true now — a
 * stale size would be worse than none.
 */

/** One measured category of on-disk data. */
export interface DiskUsageBucket {
  /** Stable id, so the dashboard can key rows without matching on copy. */
  readonly id: "telemetry_hourly" | "telemetry_compacted" | "payload_frames";
  readonly label: string;
  readonly bytes: number;
  readonly files: number;
  /** Why this data exists, shown next to the size. */
  readonly note: string;
  /** Bytes reclaimable right now, when that is knowable without a dry run. */
  readonly reclaimableBytes: number | null;
  readonly reclaimableFiles: number | null;
}

export interface DiskUsageResponse {
  readonly buckets: readonly DiskUsageBucket[];
  readonly totalBytes: number;
  /** Retention in days; telemetry older than this is outside every scan. */
  readonly retentionDays: number;
  /** Payload frames live this long before they are reclaimable. */
  readonly payloadRetentionMs: number;
}

export type ReclaimAction = "payload_frames" | "telemetry_retention" | "telemetry_hourly";

export interface ReclaimResponse {
  readonly action: ReclaimAction;
  readonly deletedFiles: number;
  readonly reclaimedBytes: number;
}

export interface FlushResponse {
  readonly flushed: boolean;
}

/**
 * A reclaim the caller is not allowed to make.
 *
 * Kept as a named class so the route maps it to 403 rather than letting it
 * surface as a 500 — an operator asking for something out of policy is a
 * normal request, not a failure.
 */
export class ReclaimNotAllowedError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "ReclaimNotAllowedError";
  }
}
