import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accumulate,
  emptyBucket,
  mergeBucketsInternal,
  type CompactedBucket,
} from "./event-compaction";
import { TELEMETRY_EVENT_DIR, type TelemetryEventRecord } from "./event-log";

/**
 * One sidecar index per day, beside that day's append-only event file.
 *
 * The event file grows all day and is never rewritten while it is open. The
 * index is the thing the dashboard reads: it holds the same totals and the same
 * breakdown counts the old per-day compaction produced, but they are maintained
 * incrementally from a byte watermark rather than rebuilt by folding and
 * deleting source files.
 *
 * That watermark is the whole reason this replaces the old scheme. Which file
 * was still being written used to be decided by comparing file *names*, so the
 * open file was periodically folded and unlinked mid-write, and its requests
 * never reached the summary. A byte offset has no such ambiguity: everything
 * below it is counted, everything above it is not, and re-reading the tail is
 * idempotent.
 */

/**
 * An event whose tenant is known to be present.
 *
 * `tenantId` is optional on the record because a row can arrive without one,
 * but the index is keyed by tenant, so only rows carrying one are folded.
 */
type FoldedEvent = TelemetryEventRecord & { readonly tenantId: string };

/** Marker so a reader can tell an index from anything else in the directory. */
const INDEX_KIND = "telemetry-day-index" as const;

/** Version bumped whenever the shape changes; an unreadable version is ignored. */
const INDEX_VERSION = 1 as const;

/** The event file for one UTC day. */
export function dayEventFileName(day: string): string {
  return `${day}.events.jsonl`;
}

/** The sidecar index for one UTC day. */
export function dayIndexFileName(day: string): string {
  return `${day}.index.json`;
}

/** The UTC day (`2026-10-22`) a moment belongs to. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * One hour's share of a bucket.
 *
 * The Traffic chart asks how a day was spent, which the totals alone cannot
 * answer. Twenty-four slots per bucket is small — four numbers each — and is
 * held *inside* the index rather than as the per-hour files this replaced.
 */
/**
 * One named dimension's share of a bucket.
 *
 * The breakdown asks for tokens, errors and cost per model/provider/client/IP,
 * not merely how many requests each took. Counts alone were enough for the old
 * per-day totals, but the breakdown columns would all have read zero, so each
 * named entry carries the same running sums the bucket does.
 */
export interface IndexedDimension {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
  readonly estimatedCostUsd: number;
  readonly tokensPerSecSum: number;
  readonly tokensPerSecCount: number;
}

export interface IndexedHour {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
}

/** One tenant/key pair's running totals for the day. */
export interface IndexedBucket extends CompactedBucket {
  readonly tenantId: string;
  readonly apiKeyId: string | null;
  /** Index 0-23, the UTC hour an event fell in. */
  readonly hours: readonly IndexedHour[];
  /** Per-name sums for each breakdown dimension. */
  readonly dimModel: Readonly<Record<string, IndexedDimension>>;
  readonly dimProvider: Readonly<Record<string, IndexedDimension>>;
  readonly dimClient: Readonly<Record<string, IndexedDimension>>;
  readonly dimClientIp: Readonly<Record<string, IndexedDimension>>;
}

/** The on-disk shape of a day index. */
export interface DayIndex {
  readonly kind: typeof INDEX_KIND;
  readonly version: typeof INDEX_VERSION;
  readonly day: string;
  /**
   * Bytes of the event file already folded in.
   *
   * Everything past this offset is uncounted; a crash between append and index
   * write only ever leaves it behind, never ahead, so the tail is re-read.
   */
  readonly watermarkBytes: number;
  /** Totals per tenant/key. */
  readonly buckets: readonly IndexedBucket[];
  /** Wall-clock of the last fold, for operators reading the file by hand. */
  readonly updatedAt: string;
}

function bucketKey(tenantId: string, apiKeyId: string | null): string {
  return `${tenantId}|${apiKeyId ?? ""}`;
}

/** Twenty-four empty hour slots. */
function emptyHours(): IndexedHour[] {
  return Array.from({ length: 24 }, () => ({
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  }));
}

/** The UTC hour (0-23) of an ISO timestamp. */
function hourOf(createdAt: string): number {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return 0;
  return Number.parseInt(createdAt.slice(11, 13), 10) || 0;
}

/** An empty per-name entry. */
function emptyDimension(): IndexedDimension {
  return {
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    errors: 0,
    estimatedCostUsd: 0,
    tokensPerSecSum: 0,
    tokensPerSecCount: 0,
  };
}

/**
 * A cost as a number.
 *
 * Costs arrive as strings from `numeric` columns and from restored rows, and
 * `0 + "0.000966"` concatenates rather than sums. Coerced once, here, so the
 * per-name breakdown cannot accumulate a string the way it did.
 */
function numericCost(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

/** Folds one event into one named dimension entry. */
function foldDimension(
  into: Readonly<Record<string, IndexedDimension>> | undefined,
  name: string | null | undefined,
  event: FoldedEvent,
): Record<string, IndexedDimension> {
  const out: Record<string, IndexedDimension> = { ...(into ?? {}) };
  const key = typeof name === "string" ? name.trim() : "";
  if (key === "") return out;
  const prior = out[key] ?? emptyDimension();
  const failed = event.status === "failed" ? 1 : 0;
  out[key] = {
    requests: prior.requests + 1,
    inputTokens: prior.inputTokens + (event.inputTokens ?? 0),
    cachedTokens: prior.cachedTokens + (event.cachedInputTokens ?? 0),
    outputTokens: prior.outputTokens + (event.outputTokens ?? 0),
    errors: prior.errors + failed,
    estimatedCostUsd: prior.estimatedCostUsd + numericCost(event.estimatedCostUsd),
    tokensPerSecSum: prior.tokensPerSecSum + (event.tokensPerSec ?? 0),
    tokensPerSecCount: prior.tokensPerSecCount + (event.tokensPerSec === null ? 0 : 1),
  };
  return out;
}

/** Adds one event's tokens into its hour slot. */
function withHour(
  hours: readonly IndexedHour[],
  event: FoldedEvent,
): IndexedHour[] {
  const base = hours.length === 24 ? [...hours] : emptyHours();
  const index = hourOf(event.createdAt);
  const prior = base[index] ?? { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  base[index] = {
    requests: prior.requests + 1,
    inputTokens: prior.inputTokens + (event.inputTokens ?? 0),
    cachedTokens: prior.cachedTokens + (event.cachedInputTokens ?? 0),
    outputTokens: prior.outputTokens + (event.outputTokens ?? 0),
  };
  return base;
}

/** An empty index for a day with nothing counted yet. */
export function emptyDayIndex(day: string): DayIndex {
  return {
    kind: INDEX_KIND,
    version: INDEX_VERSION,
    day,
    watermarkBytes: 0,
    buckets: [],
    updatedAt: new Date().toISOString(),
  };
}

/** True when the index is one this version can read. */
function isDayIndex(value: unknown): value is DayIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DayIndex>;
  return (
    candidate.kind === INDEX_KIND &&
    candidate.version === INDEX_VERSION &&
    typeof candidate.day === "string" &&
    typeof candidate.watermarkBytes === "number" &&
    Array.isArray(candidate.buckets)
  );
}

/** Reads a day index, or an empty one when it is absent or unreadable. */
export async function readDayIndex(day: string): Promise<DayIndex> {
  const text = await readFile(join(TELEMETRY_EVENT_DIR, dayIndexFileName(day)), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return emptyDayIndex(day);
  try {
    const parsed: unknown = JSON.parse(text);
    return isDayIndex(parsed) ? parsed : emptyDayIndex(day);
  } catch {
    // A torn index costs nothing to rebuild — the event file is the record — so
    // a parse failure starts over rather than failing the read.
    return emptyDayIndex(day);
  }
}

/**
 * Writes an index atomically.
 *
 * Written to a pid-suffixed temp file and renamed, so a reader never sees a
 * half-written index and a crash mid-write leaves the previous one in place.
 */
export async function writeDayIndex(index: DayIndex): Promise<void> {
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const target = join(TELEMETRY_EVENT_DIR, dayIndexFileName(index.day));
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(index)}\n`, "utf8");
  await rename(temp, target);
}

/** Byte size of a day's event file; 0 when it does not exist. */
export async function dayEventFileBytes(day: string): Promise<number> {
  const size = await stat(join(TELEMETRY_EVENT_DIR, dayEventFileName(day)))
    .then((value) => value.size)
    .catch(() => undefined);
  return size ?? 0;
}

/**
 * Reads the uncounted tail of a day's event file.
 *
 * Only bytes past `fromBytes` are read, and a partial line at the very end is
 * dropped rather than counted: the writer may still be appending to it, and a
 * line that is not yet terminated is not yet an event.
 */
async function* readTail(
  day: string,
  fromBytes: number,
): AsyncGenerator<{ readonly event: FoldedEvent; readonly endBytes: number }> {
  const handle = await open(join(TELEMETRY_EVENT_DIR, dayEventFileName(day)), "r").catch(
    () => undefined,
  );
  if (handle === undefined) return;
  try {
    const size = (await handle.stat().catch(() => undefined))?.size ?? 0;
    if (size <= fromBytes) return;
    const length = size - fromBytes;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fromBytes);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // The final element is either empty or a line the writer has not finished;
    // a unterminated line is not an event yet, so it is left for the next fold.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    else lines.pop();
    let consumed = 0;
    for (const line of lines) {
      consumed += Buffer.byteLength(line, "utf8") + 1;
      if (line.length === 0) continue;
      const event = parseEventLine(line);
      if (event !== undefined) yield { event, endBytes: fromBytes + consumed };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Parses one event line, or `undefined` when it is not a usable event. */
function parseEventLine(line: string): FoldedEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["tenantId"] !== "string") return undefined;
    if (typeof candidate["requestId"] !== "string") return undefined;
    if (typeof candidate["createdAt"] !== "string") return undefined;
    // `tenantId` is checked above but declared optional on the record, so the
  // narrow shape is asserted here rather than at every use site.
  return candidate as unknown as FoldedEvent;
  } catch {
    return undefined;
  }
}

/**
 * Folds every event written since the watermark into the day index.
 *
 * Safe to call as often as you like: the watermark advances only after the
 * index is on disk, so a crash means some events are folded twice at worst —
 * and folding is a sum, so that is corrected by running again with the tail,
 * not by any compensating logic.
 */
export async function foldDayIndex(day: string): Promise<{ readonly folded: number }> {
  const index = await readDayIndex(day);
  const byKey = new Map<string, IndexedBucket>();
  for (const bucket of index.buckets) {
    byKey.set(bucketKey(bucket.tenantId, bucket.apiKeyId), bucket);
  }

  let watermark = index.watermarkBytes;
  let folded = 0;
  for await (const { event, endBytes } of readTail(day, index.watermarkBytes)) {
    const key = bucketKey(event.tenantId, event.apiKeyId ?? null);
    const prior = byKey.get(key);
    const base: IndexedBucket =
      prior ?? {
        ...emptyBucket(),
        tenantId: event.tenantId,
        apiKeyId: event.apiKeyId ?? null,
        hours: emptyHours(),
        dimModel: {},
        dimProvider: {},
        dimClient: {},
        dimClientIp: {},
      };
    byKey.set(key, {
      ...accumulate(base, event),
      tenantId: base.tenantId,
      apiKeyId: base.apiKeyId,
      hours: withHour(base.hours, event),
      dimModel: foldDimension(base.dimModel, event.requestedModel ?? event.reportedModel, event),
      dimProvider: foldDimension(base.dimProvider, event.providerId, event),
      dimClient: foldDimension(base.dimClient, event.sourceSurface, event),
      dimClientIp: foldDimension(base.dimClientIp, event.clientIp, event),
    });
    watermark = Math.max(watermark, endBytes);
    folded += 1;
  }

  if (folded === 0) return { folded: 0 };
  await writeDayIndex({
    kind: INDEX_KIND,
    version: INDEX_VERSION,
    day,
    watermarkBytes: watermark,
    buckets: [...byKey.values()],
    updatedAt: new Date().toISOString(),
  });
  return { folded };
}

/** The days whose index should be folded, newest last. */
export async function listEventDays(): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  const days = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".events.jsonl")) days.add(file.slice(0, 10));
  }
  return [...days].sort();
}

/**
 * Every bucket for one tenant, across the days a period covers.
 *
 * Reads only the index files for those days — a few small JSON reads — rather
 * than parsing the event files, which is what made a usage query cost grow with
 * traffic.
 */
export async function queryIndexedBuckets(options: {
  /** Omit to read every tenant — a caller that filters by key, not by tenant. */
  readonly tenantId?: string | undefined;
  readonly since?: Date | undefined;
  /** Fold each day's tail first, so a read never reports a stale total. */
  readonly foldFirst?: boolean;
}): Promise<readonly IndexedBucket[]> {
  const days = await listEventDays();
  const sinceDay = options.since === undefined ? undefined : utcDay(options.since);
  const out: IndexedBucket[] = [];
  for (const day of days) {
    if (sinceDay !== undefined && day < sinceDay) continue;
    if (options.foldFirst === true) await foldDayIndex(day).catch(() => ({ folded: 0 }));
    const index = await readDayIndex(day);
    for (const bucket of index.buckets) {
      if (options.tenantId !== undefined && bucket.tenantId !== options.tenantId) continue;
      out.push(bucket);
    }
  }
  return out;
}

/** The days a period spans, oldest first. */
export function daysSince(since: Date | undefined, now = new Date()): readonly string[] {
  const start = since === undefined ? now : since;
  const out: string[] = [];
  const cursor = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  ));
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  while (cursor.getTime() <= end && out.length < 400) {
    out.push(utcDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export { mergeBucketsInternal as mergeBuckets };
