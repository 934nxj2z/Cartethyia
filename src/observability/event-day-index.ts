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

/** One tenant/key pair's running totals for the day. */
export interface IndexedBucket extends CompactedBucket {
  readonly tenantId: string;
  readonly apiKeyId: string | null;
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
    const base = prior ?? { ...emptyBucket(), tenantId: event.tenantId, apiKeyId: event.apiKeyId ?? null };
    byKey.set(key, { ...accumulate(base, event), tenantId: base.tenantId, apiKeyId: base.apiKeyId });
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

export { mergeBucketsInternal as mergeBuckets };
