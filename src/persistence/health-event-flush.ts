// Deferred writes for the account/pool health audit log.
//
// `health_events` is an append-only operator log: nothing in the request path
// reads it. It was written synchronously inside the same transaction as the
// `provider_accounts` UPDATE that routing *does* read, so every failed attempt
// paid an extra INSERT before the request could finish — on the embedded
// backend, where writes queue behind a single writer, that was the difference
// between one write and two.
//
// Only the audit row moves off the hot path. The status UPDATE stays
// synchronous and transactional, because routing reads it: deferring that would
// let a subsequent request pick an account that had just failed, which is worse
// under exactly the failure wave this work targets.
//
// Same shape as `persistence/usage-flush.ts`: enqueue and return, a timer
// flushes, shutdown flushes what remains. A crash loses the unflushed rows and
// nothing else — the durable state routing depends on was never in here.
import type { CartethyiaDatabase } from "./db-handle";
import { healthEvents } from "./schema";

/** One audit row waiting to be written. */
export interface HealthEventRow {
  readonly entityKind: "account" | "pool";
  readonly accountId?: string | null;
  readonly networkPoolId?: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string;
  readonly errorCategory: string | null;
  readonly modelId?: string | null;
  readonly createdAt: Date;
}

/**
 * Rows dropped rather than accumulated without bound.
 *
 * A health log is worth less than a stable process: a failure wave that cannot
 * be flushed must not grow this queue until the process dies. Beyond the cap
 * the oldest rows are discarded and counted.
 */
const MAX_PENDING_ROWS = 2_000;

/**
 * Process-wide sink, injected by `account-health-service` and the pool-health
 * path.
 *
 * A module-level optional rather than a constructor parameter on every call:
 * those functions are reached from dozens of call sites with a plain database
 * handle, and threading a buffer through all of them would be a far larger
 * change than the write it defers. `undefined` means "write synchronously",
 * which is today's behaviour and what tests that assert the row landed expect.
 */
let activeBuffer: HealthEventFlushBuffer | undefined;

/** Installs the process-wide buffer. */
export function setHealthEventBuffer(buffer: HealthEventFlushBuffer | undefined): void {
  activeBuffer = buffer;
}

/** The installed buffer, or `undefined` when writes must stay synchronous. */
export function healthEventBuffer(): HealthEventFlushBuffer | undefined {
  return activeBuffer;
}

export class HealthEventFlushBuffer {
  private readonly pending: HealthEventRow[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private dropped = 0;
  /**
   * Settles once while an INSERT is in flight, so a purge that drops the
   * queue can wait that write out instead of letting it land behind its own
   * `DELETE` and resurrect the rows it just removed.
   */
  private inflightDone: Promise<void> | undefined;

  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly intervalMs = 1_000,
  ) {
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    // `unref` so a pending interval never holds the process open at shutdown;
    // `stop()` drains explicitly instead.
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Records one audit row. Never touches the database; safe per attempt. */
  enqueue(row: HealthEventRow): void {
    if (this.pending.length >= MAX_PENDING_ROWS) {
      this.pending.shift();
      this.dropped += 1;
    }
    this.pending.push(row);
  }

  /** Rows discarded because the queue was full. Observability for the buffer. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Drops queued rows — everything, or one account's — without writing them. */
  clear(accountId?: string): void {
    if (accountId === undefined) {
      this.pending.length = 0;
      return;
    }
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]?.accountId === accountId) this.pending.splice(i, 1);
    }
  }

  /**
   * Drops queued rows and then blocks until a write already in flight lands.
   *
   * The barrier is what makes a purge sound: deleting only the rows visible at
   * one instant is final, while an insert in flight for the same instant would
   * re-add rows after the `DELETE` finished. Rows enqueued *after* the drop
   * are new events, not resurrected ones, so they are left alone.
   */
  async drain(accountId?: string): Promise<void> {
    this.clear(accountId);
    await this.inflightDone;
  }

  /** Writes everything accumulated so far. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    let settle!: () => void;
    this.inflightDone = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Drained before the await: rows enqueued while the insert runs stay for
    // the next pass rather than being lost if this one throws.
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.db.insert(healthEvents).values(
        batch.map((row) => ({
          entityKind: row.entityKind,
          accountId: row.accountId ?? null,
          networkPoolId: row.networkPoolId ?? null,
          fromStatus: row.fromStatus as "active" | "cooldown" | "disabled" | null,
          toStatus: row.toStatus as "active" | "cooldown" | "disabled",
          reason: row.reason,
          errorCategory: row.errorCategory as never,
          modelId: row.modelId ?? null,
          createdAt: row.createdAt,
        })),
      );
    } catch {
      // An audit write must never fail a request or retry a dispatch. The rows
      // are dropped; the durable status change was written synchronously.
    } finally {
      this.flushing = false;
      this.inflightDone = undefined;
      settle();
    }
  }

  /** Stops the timer and flushes what remains. Called at shutdown. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
