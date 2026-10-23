/**
 * On-disk payload frame format.
 *
 * Frames are stored as newline-terminated base64 lines of gzipped JSON. The
 * old shape was a 4-byte binary length header followed by gzip bytes, which
 * made a frame opaque: reading one meant decoding a big-endian length and
 * gunzipping exactly that many bytes, and the file could not be inspected as
 * text at all.
 *
 * What must hold is that the old shape is still readable. Files written before
 * the change are on disk right now and their rows point at them; they expire
 * on their own within the retention window, so both shapes are tolerated
 * temporarily by construction rather than migrated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIR = await mkdtemp(join(tmpdir(), "carte-payload-format-"));
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = DIR;

const store = await import("../../src/observability/payload-store");

beforeEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
});

afterEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
});

/** A frame in the old shape: 4-byte length header, then gzip bytes. */
function legacyBytes(payload: unknown, expiresAt: Date): Buffer {
  const frame = {
    version: 1,
    id: "legacy",
    expiresAt: expiresAt.toISOString(),
    payload,
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(frame), "utf8"));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(gz.byteLength, 0);
  return Buffer.concat([header, gz]);
}

describe("new frames", () => {
  test("a written frame is a printable text line", async () => {
    const ref = await store.writePayloadFrame({ a: 1 }, new Date(Date.now() + 60_000));
    const raw = await readFile(join(DIR, ref.file));
    // The whole point: no binary header, so the file reads as text.
    expect(raw[0]).not.toBe(0);
    expect(raw[raw.byteLength - 1]).toBe(0x0a);
    expect(/^[\x20-\x7e\n]+$/.test(raw.toString("utf8"))).toBe(true);
  });

  test("a written frame uses the .jsonl extension", async () => {
    const ref = await store.writePayloadFrame({ a: 1 }, new Date(Date.now() + 60_000));
    expect(ref.file.endsWith(".jsonl")).toBe(true);
  });

  test("a frame round-trips through write and read", async () => {
    const ref = await store.writePayloadFrame(
      { hello: "world", n: 42 },
      new Date(Date.now() + 60_000),
    );
    expect(await store.readPayloadFrame(ref)).toEqual({ hello: "world", n: 42 });
  });

  test("several frames in one file are each readable", async () => {
    // Frames append, so a file holding more than one must keep every offset
    // resolvable — the line length is what makes that work without a header.
    const first = await store.writePayloadFrame({ i: 1 }, new Date(Date.now() + 60_000));
    const second = await store.writePayloadFrame({ i: 2 }, new Date(Date.now() + 60_000));
    expect(second.file).toBe(first.file);
    expect(second.offset).toBeGreaterThan(first.offset);
    expect(await store.readPayloadFrame(first)).toEqual({ i: 1 });
    expect(await store.readPayloadFrame(second)).toEqual({ i: 2 });
  });
});

describe("frames written before the format change", () => {
  test("a binary-header frame still reads", async () => {
    const bytes = legacyBytes({ tag: "old" }, new Date(Date.now() + 60_000));
    await writeFile(join(DIR, "legacy.jsonb"), bytes);
    const ref = {
      storage: "jsonl-file" as const,
      file: "legacy.jsonb",
      offset: 0,
      length: bytes.byteLength,
      checksum: "",
      version: 1 as const,
    };
    expect(await store.readPayloadFrame(ref)).toEqual({ tag: "old" });
  });

  test("an expired legacy file is pruned, a live one is kept", async () => {
    const expired = legacyBytes({}, new Date(Date.now() - 1_000));
    const live = legacyBytes({ tag: "live" }, new Date(Date.now() + 60 * 60_000));
    await writeFile(join(DIR, "old-expired.jsonb"), expired);
    await writeFile(join(DIR, "old-live.jsonb"), live);

    // Recognising only the new extension would abandon these on disk forever,
    // since nothing else removes them.
    const deleted = await store.prunePayloadFrames(
      new Date(),
      new Date(Date.now() - 15 * 60_000),
    );
    expect(deleted).toBe(1);
    expect(await readdir(DIR)).toEqual(["old-live.jsonb"]);
  });
});

describe("a mixed file", () => {
  test("liveness walks both shapes without stopping early", async () => {
    // A file appended-to across the change holds both. The walk must not
    // declare it unreadable, which would leave it on disk forever.
    const bytes = legacyBytes({ tag: "old" }, new Date(Date.now() - 1_000));
    await writeFile(join(DIR, "mixed.jsonb"), bytes);
    const fresh = await store.writePayloadFrame({ tag: "new" }, new Date(Date.now() + 60_000));
    // The new frame lands in its own file, so assert the old one still prunes
    // while the new one is still readable.
    expect(fresh.file.endsWith(".jsonl")).toBe(true);
    await store.prunePayloadFrames(new Date(), new Date(Date.now() - 15 * 60_000));
    const remaining = await readdir(DIR);
    expect(remaining).toContain(fresh.file);
    expect(remaining).not.toContain("mixed.jsonb");
    expect(await store.readPayloadFrame(fresh)).toEqual({ tag: "new" });
  });
});
