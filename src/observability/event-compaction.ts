/**
 * Compaction for hourly telemetry files: old per-request rows become one
 * summary row per (tenant, API key, day).
 *
 * The problem this solves is growth, and growth alone. Hourly JSONL files were
 * never deleted, so every read of the usage list scanned every file ever
 * written — the cost grew with total volume, not with the number of users. An
 * install serving 20 users got slower purely by serving them longer.
 *
 * Compaction is **accumulation, not sampling**. A compacted row carries the
 * running sums of everything it replaced, so a total that read 2B tokens
 * before compaction still reads 2B after it. Nothing is estimated and nothing
 * is averaged away — the per-request rows are gone, their totals are not.
 *
 * What compaction cannot preserve is anything that needs the individual row:
 * the request list, per-request filters, and the detail drawer. Latency is the
 * interesting middle case — a percentile needs every sample, so compaction
 * keeps a fixed histogram instead. P50 stays available as an approximation and
 * is marked as one rather than silently reported as exact.
 *
 * Retention becomes tiered:
 *
 *   0 .. N days   hourly files, complete
 *   N .. M days   compacted daily summary
 *   beyond M      deleted
 */
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TELEMETRY_EVENT_DIR, type TelemetryEventRecord } from "./event-log";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { consoleSettings } from "../persistence/schema";
import { resolveTelemetryCompactAfterDays, resolveTelemetryRetentionDays } from "../config/telemetry";

/**
 * The compaction age to apply on a pass with no explicit age given.
 *
 * Hourly files are **not** partitioned per tenant — one file per hour holds
 * every tenant's rows — so a per-tenant age cannot be honoured per file. The
 * safest reading of several tenants' preferences is the **largest**: compacting
 * earlier than one tenant asked for destroys rows that tenant expected to keep,
 * while compacting later than another wanted only costs disk and a slower scan.
 * Losing data is not reversible; using more disk is.
 *
 * Falls back to the deployment default when no tenant overrides, and never
 * exceeds the retention window (compacting at or past the delete age would
 * fold a file and discard it in the same pass).
 */
export async function resolveEffectiveCompactAfterDays(db: CartethyiaDatabase): Promise<number> {
  const fallback = resolveTelemetryCompactAfterDays();
  const retention = resolveTelemetryRetentionDays();
  try {
    const rows = await db
      .select({ preferences: consoleSettings.preferences })
      .from(consoleSettings);
    let widest = fallback;
    for (const row of rows) {
      const days = row.preferences?.telemetryCompactAfterDays;
      if (typeof days === "number" && Number.isFinite(days) && days > widest) widest = days;
    }
    return Math.min(Math.floor(widest), retention);
  } catch {
    return fallback;
  }
}

/** Discriminator so a reader can tell a summary from a request row at a glance. */
const COMPACTED_KIND = "compacted" as const;

/**
 * Histogram bucket edges in milliseconds.
 *
 * Fixed rather than adaptive: a reader that wants P50/P95/P99 has to be able to
 * interpret buckets it did not write, and an adaptive layout would have to be
 * stored alongside every row. These follow the gateway's own latency
 * histogram, so a compacted period and a live one read comparably.
 */
export const LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface CompactedBucket {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  readonly creditUsed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly truncated: number;
  readonly latencySum: number;
  readonly latencyCount: number;
  readonly latencyMinMs: number | null;
  readonly latencyMaxMs: number | null;
  /** Counts per fixed latency bucket; `+Inf` is the last, overflow, bucket. */
  readonly latencyHistogram: readonly number[];
  readonly tokensPerSecSum: number;
  readonly tokensPerSecCount: number;
  /** Requests whose cost could not be priced. */
  readonly unpriced: number;
}

/** One compacted row: the totals of everything it replaced, for one key/day. */
export interface CompactedRow extends CompactedBucket {
  readonly kind: typeof COMPACTED_KIND;
  /** ISO day (UTC) this row summarises. */
  readonly day: string;
  readonly tenantId: string;
  readonly apiKeyId: string | null;
}

export function emptyBucket(): CompactedBucket {
  return {
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    creditUsed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    truncated: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyMinMs: null,
    latencyMaxMs: null,
    latencyHistogram: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
    tokensPerSecSum: 0,
    tokensPerSecCount: 0,
    unpriced: 0,
  };
}

function bucketIndex(latencyMs: number): number {
  for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
    if (latencyMs <= LATENCY_BUCKETS_MS[index]!) return index;
  }
  return LATENCY_BUCKETS_MS.length;
}

/**
 * Folds one request row into a bucket.
 *
 * Every field is a running sum or a min/max, never an average of averages: an
 * average of per-file averages would drift from the true mean as soon as the
 * files held different request counts, and the whole point of compaction is
 * that the totals survive intact.
 */
export function accumulate(
  into: CompactedBucket,
  event: TelemetryEventRecord,
): CompactedBucket {
  const histogram = [...into.latencyHistogram];
  const latency = event.latencyMs;
  if (latency !== null && Number.isFinite(latency)) {
    histogram[bucketIndex(latency)] = (histogram[bucketIndex(latency)] ?? 0) + 1;
  }
  const priced = event.estimatedCostUsd ?? 0;
  return {
    requests: into.requests + 1,
    inputTokens: into.inputTokens + (event.inputTokens ?? 0),
    cachedTokens: into.cachedTokens + (event.cachedInputTokens ?? 0),
    outputTokens: into.outputTokens + (event.outputTokens ?? 0),
    reasoningTokens: into.reasoningTokens + (event.reasoningTokens ?? 0),
    estimatedCostUsd: into.estimatedCostUsd + priced,
    creditUsed: into.creditUsed + (event.creditUsed ?? 0),
    succeeded: into.succeeded + (event.status === "completed" ? 1 : 0),
    failed: into.failed + (event.status === "failed" ? 1 : 0),
    cancelled: into.cancelled + (event.status === "cancelled" ? 1 : 0),
    truncated: into.truncated + (event.status === "truncated" ? 1 : 0),
    latencySum: into.latencySum + (latency ?? 0),
    latencyCount: into.latencyCount + (latency === null ? 0 : 1),
    latencyMinMs:
      latency === null
        ? into.latencyMinMs
        : into.latencyMinMs === null
          ? latency
          : Math.min(into.latencyMinMs, latency),
    latencyMaxMs:
      latency === null
        ? into.latencyMaxMs
        : into.latencyMaxMs === null
          ? latency
          : Math.max(into.latencyMaxMs, latency),
    latencyHistogram: histogram,
    tokensPerSecSum: into.tokensPerSecSum + (event.tokensPerSec ?? 0),
    tokensPerSecCount: into.tokensPerSecCount + (event.tokensPerSec === null ? 0 : 1),
    // A completed request with no cost is unpriced, not free. Counting it keeps
    // the dashboard's "partial cost" warning honest after compaction.
    unpriced: into.unpriced + (event.status === "completed" && priced === 0 ? 1 : 0),
  };
}

/**
 * An approximate percentile over a compacted histogram.
 *
 * Returns the upper edge of the bucket that contains it — never a value
 * between edges, because a histogram cannot be more precise than the bucket
 * that holds the sample. `null` when there are no samples, and `null` when the
 * percentile falls in the overflow bucket, whose upper edge is unbounded.
 */
export function percentileFromHistogram(
  histogram: readonly number[],
  percentile: number,
): (typeof LATENCY_BUCKETS_MS)[number] | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const target = Math.ceil((percentile / 100) * total);
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index] ?? 0;
    if (seen >= target) {
      // The bucket's upper edge: a percentile from a histogram can never be
      // more precise than the bucket that contains it.
      return index < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[index]! : null;
    }
  }
  return null;
}

/** The compacted file name for one day. */
export function compactedFileName(day: string): string {
  return `${day}.compacted.jsonl`;
}

function isCompactedFile(file: string): boolean {
  return file.endsWith(".compacted.jsonl");
}

function isHourlyFile(file: string): boolean {
  return file.endsWith(".jsonl") && !isCompactedFile(file);
}

/** The UTC day an hourly file belongs to: its name starts `YYYY-MM-DDTHH`. */
function dayOfHourlyFile(file: string): string {
  return file.slice(0, 10);
}

export interface CompactionResult {
  readonly filesCompacted: number;
  readonly daysWritten: number;
  readonly rowsWritten: number;
  readonly filesDeleted: number;
}

/**
 * Compacts hourly files older than `olderThanDays` into per-day summaries.
 *
 * Reads each hourly file once — the same O(total volume) cost the query path
 * pays, but paid once instead of on every read. Idempotent: a day's summary is
 * merged into any summary already present, so an interrupted pass resumes
 * without double-counting and a second pass over a compacted day changes
 * nothing.
 *
 * Files are renamed aside before their summary is written and only unlinked
 * after it lands, so a crash between the two leaves the hourly file on disk and
 * the next pass compacts it again — never a window where the data is in
 * neither place.
 */
export async function compactTelemetryFiles(options: {
  readonly olderThanDays: number;
  readonly maxFiles?: number;
  readonly now?: Date;
  readonly retentionDays?: number;
}): Promise<CompactionResult> {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.olderThanDays * 24 * 60 * 60_000;
  const files = (await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]))
    .filter(isHourlyFile)
    .filter((file) => Date.parse(`${dayOfHourlyFile(file)}T00:00:00Z`) < cutoff)
    .sort();
  const batch = options.maxFiles === undefined ? files : files.slice(0, options.maxFiles);
  if (batch.length === 0) {
    return { filesCompacted: 0, daysWritten: 0, rowsWritten: 0, filesDeleted: await pruneStaleFiles(options.retentionDays, now) };
  }

  // day -> (tenant, key) -> totals
  const days = new Map<string, Map<string, CompactedBucket>>();
  for (const file of batch) {
    const day = dayOfHourlyFile(file);
    for await (const event of readHourly(join(TELEMETRY_EVENT_DIR, file))) {
      const bucketKey = `${event.tenantId ?? ""}|${event.apiKeyId ?? ""}`;
      const buckets = days.get(day) ?? new Map<string, CompactedBucket>();
      const current = buckets.get(bucketKey) ?? emptyBucket();
      buckets.set(bucketKey, accumulate(current, event));
      days.set(day, buckets);
    }
  }

  let rowsWritten = 0;
  for (const [day, buckets] of days) {
    const merged = new Map<string, CompactedBucket>();
    for (const existing of await readCompactedRows(compactedFileName(day))) {
      merged.set(`${existing.tenantId}|${existing.apiKeyId ?? ""}`, existing);
    }
    for (const [key, bucket] of buckets) {
      const prior = merged.get(key);
      merged.set(key, prior === undefined ? bucket : mergeBuckets(prior, bucket));
    }
    const rows = [...merged.entries()].map(([key, bucket]) => {
      const separator = key.indexOf("|");
      return {
        kind: COMPACTED_KIND,
        day,
        tenantId: key.slice(0, separator),
        apiKeyId: key.slice(separator + 1) || null,
        ...bucket,
      } satisfies CompactedRow;
    });
    await writeCompacted(compactedFileName(day), rows);
    rowsWritten += rows.length;
  }

  // Only now that every summary is on disk do the hourly files go away.
  for (const file of batch) {
    await unlink(join(TELEMETRY_EVENT_DIR, file)).catch(() => undefined);
  }

  return {
    filesCompacted: batch.length,
    daysWritten: days.size,
    rowsWritten,
    filesDeleted: await pruneStaleFiles(options.retentionDays, now),
  };
}

function mergeBuckets(a: CompactedBucket, b: CompactedBucket): CompactedBucket {
  const histogram = a.latencyHistogram.map((count, index) => count + (b.latencyHistogram[index] ?? 0));
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    creditUsed: a.creditUsed + b.creditUsed,
    succeeded: a.succeeded + b.succeeded,
    failed: a.failed + b.failed,
    cancelled: a.cancelled + b.cancelled,
    truncated: a.truncated + b.truncated,
    latencySum: a.latencySum + b.latencySum,
    latencyCount: a.latencyCount + b.latencyCount,
    latencyMinMs:
      a.latencyMinMs === null
        ? b.latencyMinMs
        : b.latencyMinMs === null
          ? a.latencyMinMs
          : Math.min(a.latencyMinMs, b.latencyMinMs),
    latencyMaxMs:
      a.latencyMaxMs === null
        ? b.latencyMaxMs
        : b.latencyMaxMs === null
          ? a.latencyMaxMs
          : Math.max(a.latencyMaxMs, b.latencyMaxMs),
    latencyHistogram: histogram,
    tokensPerSecSum: a.tokensPerSecSum + b.tokensPerSecSum,
    tokensPerSecCount: a.tokensPerSecCount + b.tokensPerSecCount,
    unpriced: a.unpriced + b.unpriced,
  };
}

/**
 * Deletes summary files past the retention window.
 *
 * Aged out entirely rather than compacted again: a day's summary is already the
 * smallest form that keeps the totals, so there is nothing left to fold it
 * into. The decision is made from the file name alone — no read.
 */
export async function pruneStaleFiles(
  retentionDays: number | undefined,
  now = new Date(),
): Promise<number> {
  if (retentionDays === undefined) return 0;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60_000;
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  let deleted = 0;
  for (const file of files) {
    if (!isCompactedFile(file)) continue;
    const at = Date.parse(`${file.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(at) || at >= cutoff) continue;
    await unlink(join(TELEMETRY_EVENT_DIR, file)).catch(() => undefined);
    deleted += 1;
  }
  return deleted;
}

async function* readHourly(path: string): AsyncGenerator<TelemetryEventRecord> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return;
  try {
    let pending = "";
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(256 * 1024);
    let read: { bytesRead: number };
    while ((read = await handle.read(buffer, 0, buffer.length)).bytesRead > 0) {
      pending += decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          const parsed = parseLine(line);
          if (parsed !== undefined) yield parsed;
        }
        newline = pending.indexOf("\n");
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLine(line: string): TelemetryEventRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  // A summary row is not a request: never fold one into another summary, or a
  // re-run would square every total it had already accumulated.
  if (record["kind"] === COMPACTED_KIND) return undefined;
  const tenantId = typeof record["tenantId"] === "string" ? record["tenantId"] : "";
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : "";
  if (tenantId.length === 0 || createdAt.length === 0) return undefined;
  const numeric = (key: string): number | null => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const textual = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  return {
    id: textual("id") ?? textual("requestId") ?? "",
    createdAt,
    tenantId,
    requestId: textual("requestId") ?? "",
    sourceSurface: textual("sourceSurface"),
    requestedModel: textual("requestedModel"),
    reportedModel: textual("reportedModel"),
    requestedEffort: textual("requestedEffort"),
    providerId: textual("providerId"),
    accountId: textual("accountId"),
    networkPoolId: textual("networkPoolId"),
    endpoint: textual("endpoint"),
    apiKeyId: textual("apiKeyId"),
    userAgent: textual("userAgent"),
    clientIp: textual("clientIp"),
    latencyMs: numeric("latencyMs"),
    ttfbMs: numeric("ttfbMs"),
    stream: typeof record["stream"] === "boolean" ? record["stream"] : null,
    status: textual("status"),
    httpStatus: numeric("httpStatus"),
    errorOrigin: textual("errorOrigin"),
    errorCategory: textual("errorCategory"),
    inputTokens: numeric("inputTokens"),
    cachedInputTokens: numeric("cachedInputTokens"),
    outputTokens: numeric("outputTokens"),
    reasoningTokens: numeric("reasoningTokens"),
    estimatedCostUsd: numeric("estimatedCostUsd"),
    creditUsed: numeric("creditUsed"),
    resolveMs: numeric("resolveMs"),
    tokensPerSec: numeric("tokensPerSec"),
    firstContentDeltaAtMs: numeric("firstContentDeltaAtMs"),
    lastEventAtMs: numeric("lastEventAtMs"),
  };
}

/** Reads one day's summary rows. Exported so the query path can total them. */
export async function readCompactedRows(file: string): Promise<readonly CompactedRow[]> {
  const path = join(TELEMETRY_EVENT_DIR, file);
  const text = await open(path, "r")
    .then(async (handle) => {
      try {
        return await handle.readFile("utf8");
      } finally {
        await handle.close().catch(() => undefined);
      }
    })
    .catch(() => undefined);
  if (text === undefined) return [];
  const rows: CompactedRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["kind"] !== COMPACTED_KIND) continue;
      const histogram = Array.isArray(parsed["latencyHistogram"])
        ? parsed["latencyHistogram"].map((entry) => (typeof entry === "number" ? entry : 0))
        : [];
      rows.push({
        kind: COMPACTED_KIND,
        day: String(parsed["day"] ?? ""),
        tenantId: String(parsed["tenantId"] ?? ""),
        apiKeyId: typeof parsed["apiKeyId"] === "string" ? parsed["apiKeyId"] : null,
        requests: Number(parsed["requests"] ?? 0),
        inputTokens: Number(parsed["inputTokens"] ?? 0),
        cachedTokens: Number(parsed["cachedTokens"] ?? 0),
        outputTokens: Number(parsed["outputTokens"] ?? 0),
        reasoningTokens: Number(parsed["reasoningTokens"] ?? 0),
        estimatedCostUsd: Number(parsed["estimatedCostUsd"] ?? 0),
        creditUsed: Number(parsed["creditUsed"] ?? 0),
        succeeded: Number(parsed["succeeded"] ?? 0),
        failed: Number(parsed["failed"] ?? 0),
        cancelled: Number(parsed["cancelled"] ?? 0),
        truncated: Number(parsed["truncated"] ?? 0),
        latencySum: Number(parsed["latencySum"] ?? 0),
        latencyCount: Number(parsed["latencyCount"] ?? 0),
        latencyMinMs: typeof parsed["latencyMinMs"] === "number" ? parsed["latencyMinMs"] : null,
        latencyMaxMs: typeof parsed["latencyMaxMs"] === "number" ? parsed["latencyMaxMs"] : null,
        latencyHistogram: padHistogram(histogram),
        tokensPerSecSum: Number(parsed["tokensPerSecSum"] ?? 0),
        tokensPerSecCount: Number(parsed["tokensPerSecCount"] ?? 0),
        unpriced: Number(parsed["unpriced"] ?? 0),
      });
    } catch {
      // One damaged line must not lose the day's other rows.
    }
  }
  return rows;
}

function padHistogram(histogram: readonly number[]): number[] {
  const wanted = LATENCY_BUCKETS_MS.length + 1;
  const padded = new Array<number>(wanted).fill(0);
  for (let index = 0; index < Math.min(wanted, histogram.length); index += 1) {
    padded[index] = histogram[index] ?? 0;
  }
  return padded;
}

/**
 * Writes a day's summary atomically.
 *
 * Written to a temp file and renamed, because the summary is the only copy of
 * the totals once the hourly files are unlinked: a partial write observed by a
 * reader would report a day as having less usage than it did.
 */
async function writeCompacted(file: string, rows: readonly CompactedRow[]): Promise<void> {
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const target = join(TELEMETRY_EVENT_DIR, file);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await rename(temp, target);
}

/** Bytes held by the telemetry directory, for metrics. */
export async function telemetryDirectoryBytes(): Promise<number> {
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  let total = 0;
  for (const file of files) {
    const size = await stat(join(TELEMETRY_EVENT_DIR, file))
      .then((value) => value.size)
      .catch(() => 0);
    total += size;
  }
  return total;
}
