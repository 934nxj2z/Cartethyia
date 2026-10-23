/**
 * Payload frames are gzipped on write and named `jsonl-file`.
 *
 * A frame written before compression existed is plain JSON named `jsonb-file`,
 * and the baseline accepts both storage names so older rows remain readable.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  applySqliteMigrations,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import {
  payloadDirectory,
  prunePayloadFrames,
  readPayloadFrame,
  writePayloadFrame,
  type PayloadFileReference,
} from "../../src/observability/payload-store";

const FRAME_HEADER_BYTES = 4;

function payloadDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
  process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = dir;
  return dir;
}

/**
 * The compressed bytes of one frame, out of its stored line.
 *
 * A line is base64 of the gzipped frame plus a newline, so the body is decoded
 * rather than sliced past a binary length header.
 */
async function storedBody(reference: PayloadFileReference): Promise<Buffer> {
  const data = await readFile(join(payloadDirectory(), reference.file));
  const line = data
    .subarray(reference.offset, reference.offset + reference.length)
    .toString("utf8")
    .trim();
  return Buffer.from(line, "base64");
}

test("a written frame is gzipped, smaller than its JSON, and reads back whole", async () => {
  payloadDir();
  const repeated = "system prompt repeated on every request. ".repeat(200);
  const payload = { request_id: "request-1", request_body: { prompt: repeated } };

  const reference = await writePayloadFrame(payload, new Date("2026-01-01T00:15:00.000Z"));

  expect(reference.storage).toBe("jsonl-file");
  const stored = await storedBody(reference);
  expect(stored.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  // The decompressed body is the frame, which wraps the payload, so this
  // bounds the frame rather than the payload alone.
  const decompressed = gunzipSync(stored);
  expect(stored.byteLength).toBeLessThan(decompressed.byteLength / 5);
  expect(await readPayloadFrame(reference)).toEqual(payload);
});

test("a frame written as plain JSON before compression still reads back", async () => {
  const dir = payloadDir();
  const payload = { request_id: "old-request", request_body: { prompt: "written before gzip" } };
  const frame = Buffer.from(JSON.stringify({
    version: 1,
    id: "frame-1",
    expiresAt: "2026-01-01T00:15:00.000Z",
    payload,
  }), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(frame.byteLength, 0);
  const file = "2026-01-01T00-legacy.jsonb";
  await Bun.write(join(dir, file), Buffer.concat([header, frame]));

  // The checksum the old writer recorded: FNV-1a over the plain JSON.
  let hash = 2166136261;
  for (let index = 0; index < frame.byteLength; index += 1) {
    hash ^= frame[index]!;
    hash = Math.imul(hash, 16777619);
  }
  const reference: PayloadFileReference = {
    storage: "jsonb-file",
    file,
    offset: 0,
    length: FRAME_HEADER_BYTES + frame.byteLength,
    checksum: (hash >>> 0).toString(16).padStart(8, "0"),
    version: 1,
  };
  expect(await readPayloadFrame(reference)).toEqual(payload);
});

test("a file of only expired compressed frames is reclaimed", async () => {
  payloadDir();
  const reference = await writePayloadFrame(
    { request_id: "gone" },
    new Date("2026-01-01T00:15:00.000Z"),
  );
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(1);
  expect(await stat(join(payloadDirectory(), reference.file)).then(() => true).catch(() => false)).toBe(false);
});

test("a compressed frame still inside its window keeps the file", async () => {
  payloadDir();
  await writePayloadFrame({ request_id: "kept" }, new Date("2026-06-01T00:15:00.000Z"));
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(0);
});

test("the baseline accepts old and compressed payload frame rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-migrate-"));
  const file = join(dir, "cartethyia.sqlite");
  const sqlite = createSqliteDatabase(file);
  await applySqliteMigrations(sqlite);

  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  const insert = (storage: string): void => {
    sqlite.exec(
      "INSERT INTO telemetry_payloads (id, tenant_id, captured_at, expires_at, storage, file, offset, length, checksum, version) " +
        `VALUES ('id-${storage}', 't1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', '${storage}', 'f.jsonb', 0, 4, 'abcd', 1)`,
    );
  };
  insert("jsonb-file");
  insert("jsonl-file");
  expect(() => insert("parquet")).toThrow();

  // Nothing was lost or doubled: the rebuild keeps one row per insert.
  const count = sqlite.prepare("SELECT count(*) AS c FROM telemetry_payloads").get() as { c: number };
  expect(count.c).toBe(2);
  sqlite.close();
});
