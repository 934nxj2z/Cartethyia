import { describe, expect, test } from "bun:test";
import {
  accountSocketBytes,
  accountSocketWrites,
  drainPoolByteDelta,
  poolByteTotals,
  recordPoolBytes,
  resetPoolByteAccounting,
} from "../../src/network/pool/byte-accounting";

/**
 * What a pool is charged for.
 *
 * The quota bar reads these totals, so a gap here is not a rounding detail —
 * an operator sees a pool as under its allowance when it has already spent it.
 *
 * The two gaps this pins: bytes the peer sent before the `data` listener was
 * attached (the CONNECT `head`), and string writes counted as characters rather
 * than the bytes that actually go on the wire.
 */
describe("pool byte accounting", () => {
  test("counts a string write as its bytes, not its characters", () => {
    resetPoolByteAccounting();
    const socket = { write: (): boolean => true } as unknown as { write: (...args: never[]) => unknown };
    accountSocketWrites(socket, "pool-a");
    // "é" is one character and two UTF-8 bytes.
    socket.write("é" as never);
    expect(poolByteTotals("pool-a").sent).toBe(2);
  });

  test("honours the encoding passed to write", () => {
    resetPoolByteAccounting();
    const socket = { write: (): boolean => true } as unknown as { write: (...args: never[]) => unknown };
    accountSocketWrites(socket, "pool-a");
    // Same character, hex: three bytes on the wire.
    (socket.write as (...args: unknown[]) => unknown)("e9", "hex");
    expect(poolByteTotals("pool-a").sent).toBe(1);
  });

  test("counts inbound chunks from the data listener", () => {
    resetPoolByteAccounting();
    const socket = {
      on: (event: string, listener: (chunk: unknown) => void): unknown => {
        if (event === "data") listener(Buffer.alloc(512));
        return socket;
      },
    } as unknown as { on: (event: string, listener: (chunk: unknown) => void) => unknown };
    accountSocketBytes(socket, "pool-a");
    expect(poolByteTotals("pool-a").received).toBe(512);
  });

  test("a byte credited directly is counted, as the CONNECT head is", () => {
    // The tunnel's `head` is replayed with `unshift`, which a `data` listener
    // attached afterwards never observes — so it has to be credited directly.
    resetPoolByteAccounting();
    recordPoolBytes("pool-a", "received", 64);
    expect(poolByteTotals("pool-a").received).toBe(64);
  });

  test("a drain reports only what arrived since the last one", () => {
    resetPoolByteAccounting();
    recordPoolBytes("pool-a", "sent", 100);
    expect(drainPoolByteDelta("pool-a").sent).toBe(100);
    // Nothing new since; the persisted high-water mark must not double-count.
    expect(drainPoolByteDelta("pool-a").sent).toBe(0);
    recordPoolBytes("pool-a", "sent", 50);
    expect(drainPoolByteDelta("pool-a").sent).toBe(50);
  });

  test("ignores a write with no measurable length", () => {
    resetPoolByteAccounting();
    const socket = { write: (): boolean => true } as unknown as { write: (...args: never[]) => unknown };
    accountSocketWrites(socket, "pool-a");
    (socket.write as (...args: unknown[]) => unknown)(undefined);
    expect(poolByteTotals("pool-a").sent).toBe(0);
  });
});
