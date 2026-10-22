/**
 * Durable, metadata-only request telemetry retention resolvers.
 */

import { CONFIG_SPEC, readInt } from "./spec";

/** Metadata-only telemetry retention window; payload frames have their own short TTL. */
export function resolveTelemetryRetentionDays(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_RETENTION_DAYS",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_RETENTION_DAYS,
  );
}

/** Combined redacted payload capture limit for the five stored body surfaces. */
export function resolveTelemetryPayloadMaxBytes(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES,
  );
}

/**
 * Age at which hourly telemetry files are compacted into a per-day summary.
 *
 * Clamped below the retention window: compacting at or past the delete age
 * would fold a file and throw it away in the same pass, spending the read for
 * totals that were about to be discarded.
 */
export function resolveTelemetryCompactAfterDays(): number {
  const compacted = readInt(
    "CARTETHYIA_TELEMETRY_COMPACT_AFTER_DAYS",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_COMPACT_AFTER_DAYS,
  );
  return Math.min(compacted, resolveTelemetryRetentionDays());
}

/** Minutes between compaction passes. */
export function resolveTelemetryCompactIntervalMs(): number {
  const minutes = readInt(
    "CARTETHYIA_TELEMETRY_COMPACT_INTERVAL_MINUTES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_COMPACT_INTERVAL_MINUTES,
  );
  return minutes * 60_000;
}

/**
 * Minutes of events per source file, before it is folded into the day summary.
 *
 * Defaults to the sweep interval so exactly one window closes per pass: a
 * window longer than the interval would leave files waiting several passes, and
 * a shorter one would let several close between passes.
 */
export function resolveTelemetryWindowMinutes(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_WINDOW_MINUTES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_WINDOW_MINUTES,
  );
}

/** Maximum hourly files folded in one compaction pass. */
export function resolveTelemetryCompactMaxFiles(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_COMPACT_MAX_FILES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_COMPACT_MAX_FILES,
  );
}
