/**
 * Disk housekeeping: what the telemetry and payload directories hold, and the
 * reclaim actions an operator can run from the console.
 *
 * Everything here is files on disk, except one deliberate row-level action.
 * Reclaiming a file is safe because the data it held is already past the point
 * where the gateway would read it: payload frames expire 15 minutes after they
 * are written, and telemetry files past the retention window are outside every
 * query's scan bound. Deleting rows is a different decision with a different
 * blast radius, and the only row data the console offers purging is the health
 * & error log — purely an operator's diagnostic trail with no request-path
 * reader, unlike everything else in this panel.
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
  /**
   * Stored health & error rows, for the purge row's label. Absent when the
   * composition does not wire the health-event store (a reduced console),
   * which is also when the purge control is not offered.
   */
  readonly healthEventCount?: number;
}

export type ReclaimAction = "payload_frames" | "telemetry_retention" | "telemetry_hourly";

export interface ReclaimResponse {
  readonly action: ReclaimAction;
  readonly deletedFiles: number;
  readonly reclaimedBytes: number;
}

/** Row-level deletion targets. The health & error log is the only one. */
export type PurgeTarget = "health_events";

export interface PurgeResponse {
  readonly target: PurgeTarget;
  /** Rows actually deleted — the number the operator's decision produced. */
  readonly deleted: number;
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

/** A purge whose backing store is not wired in this composition. */
export class PurgeNotWiredError extends Error {
  readonly status = 501;

  constructor() {
    super("Health & error log purging is not offered in this deployment's console composition.");
    this.name = "PurgeNotWiredError";
  }
}
