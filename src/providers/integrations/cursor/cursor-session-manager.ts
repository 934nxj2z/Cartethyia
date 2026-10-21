// Live Cursor Run sessions, and the tool-call continuation they make possible.
//
// Cursor's tool loop spans *two* client HTTP requests: the first returns a tool
// call, the second submits that tool's result. The upstream Run must be the same
// Run, and it must stay open between them, so the Run cannot be owned by either
// request — it is owned here.
//
// This manager is process-local by construction. A Run is an HTTP/2 socket; it
// cannot survive a restart, and it is not shared across processes. After a
// restart the adapter rebases from the complete request history instead (see
// `cursor.ts`), which is why an orphan tool result with no history fails
// explicitly rather than silently starting a new Run.
//
// Everything the manager holds is bounded: one idle TTL, one release per
// session, one frame pump per Run, and one terminal path that closes the stream
// and releases the borrowed lease exactly once.
import { GatewayError } from "../../../protocol/gateway-error";
import type { UsageRecord } from "../../../protocol/canonical-model";
import type { AttemptLeaseOwnership } from "../../provider-contracts";
import { RUN_IDLE_TTL_MS } from "./cursor-shared";
import type { CursorToolDescriptor } from "./cursor-request";

/** Identity a later request must present to claim a pending tool call. */
export interface CursorContinuationScope {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
}

/** One pending external tool call awaiting the client's result. */
export interface CursorPendingToolCall {
  /** Unguessable call id handed to the client. */
  readonly callId: string;
  /** Cursor's exec message id the result must echo. */
  readonly execId: number;
  /** Bare function name the client declared. */
  readonly toolName: string;
}

/** Everything one live Run session owns. */
export interface CursorRunSession {
  readonly runId: string;
  readonly conversationId: string;
  readonly scope: CursorContinuationScope;
  /** Declared tools for this Run; an inbound call outside them is refused. */
  readonly descriptors: readonly CursorToolDescriptor[];
  /** Cursor exec id → pending call id. */
  readonly pending: Map<number, string>;
  /** Pending call id → Cursor exec id and name. */
  readonly calls: Map<string, CursorPendingToolCall>;
  /** Usage reported by the Run's `turn_ended`, when it has arrived. */
  usage: UsageRecord | undefined;
  /** Terminal reason this Run ended, once it has. */
  failure: GatewayError | undefined;
}

/** Registry entry: one live Run, its expiry, and its borrowed lease release. */
interface LiveRun {
  readonly session: CursorRunSession;
  /**
   * The borrowed account/network-pool lease release. Optional and mutable: a
   * continuation request that re-enters an already-registered Run hands over the
   * lease it took, and `adoptLease` refuses when one is already stored — so the
   * slot is released exactly once however many requests touched the Run.
   */
  releaseLease?: (() => void) | undefined;
  readonly close: (reason?: string) => void;
  expiryTimer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

/**
 * Bounded, tenant/API-key-scoped registry of live Cursor Runs.
 *
 * A continuation is authorized by *server-recorded* affinity only: a call id is
 * unguessable, and resolving one additionally requires the same tenant, API key,
 * provider, and account that created it. A caller that guesses or replays a call
 * id from another key resolves nothing, so one tenant's tool result can never be
 * written onto another tenant's Run.
 */
export class CursorRunSessionManager {
  /** runId → live Run. */
  private readonly runs = new Map<string, LiveRun>();
  /** Pending call id → runId. Second index: resolution is by call id. */
  private readonly callOwners = new Map<string, string>();

  /** Live Run count, for tests and runtime assertions. */
  get size(): number {
    return this.runs.size;
  }

  /**
   * Registers one live Run.
   *
   * `releaseLease` is the borrowed account/network-pool lease the manager now
   * owns: the request that opened the Run transferred it instead of releasing it
   * at response time. It is called exactly once, on the Run's single terminal
   * path.
   */
  register(input: {
    readonly session: CursorRunSession;
    readonly releaseLease?: (() => void) | undefined;
    readonly close: (reason?: string) => void;
    readonly idleTtlMs?: number;
  }): void {
    const idleTtlMs = input.idleTtlMs ?? RUN_IDLE_TTL_MS;
    const runId = input.session.runId;
    const entry: LiveRun = {
      session: input.session,
      ...(input.releaseLease === undefined ? {} : { releaseLease: input.releaseLease }),
      close: input.close,
      expiresAt: Date.now() + idleTtlMs,
      expiryTimer: setTimeout(() => {
        this.terminate(runId, "Cursor Run idle-expired waiting for a tool result");
      }, idleTtlMs),
    };
    entry.expiryTimer.unref?.();
    this.runs.set(runId, entry);
  }

  /** Ends one Run: closes its stream and releases what it borrowed, once. */
  terminate(runId: string, reason?: string): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    this.runs.delete(runId);
    for (const callId of entry.session.pending.values()) {
      if (this.callOwners.get(callId) === runId) this.callOwners.delete(callId);
    }
    for (const call of entry.session.calls.values()) {
      if (this.callOwners.get(call.callId) === runId) this.callOwners.delete(call.callId);
    }
    clearTimeout(entry.expiryTimer);
    try {
      entry.close(reason);
    } catch {
      // Closing a dead stream must not skip the lease release below.
    }
    try {
      entry.releaseLease?.();
    } catch {
      // A failed release must not propagate out of teardown.
    }
  }

  /** Registers one pending external tool call on a live Run. */
  registerPendingCall(runId: string, call: CursorPendingToolCall): boolean {
    const entry = this.runs.get(runId);
    if (entry === undefined) return false;
    entry.session.pending.set(call.execId, call.callId);
    entry.session.calls.set(call.callId, call);
    this.callOwners.set(call.callId, runId);
    return true;
  }

  /**
   * Resolves one pending call id to its live Run, scoped to the caller.
   *
   * Returns the Run only when the id is pending *and* every scope field matches
   * the Run that created it. A mismatch is a hard refusal, not a fallback:
   * routing one account's tool result onto another account's Run would corrupt
   * both conversations and leak the first account's context into the second.
   */
  resolveCall(
    callId: string,
    scope: CursorContinuationScope,
  ): { session: CursorRunSession; call: CursorPendingToolCall } | undefined {
    const runId = this.callOwners.get(callId);
    if (runId === undefined) return undefined;
    const entry = this.runs.get(runId);
    if (entry === undefined) return undefined;
    const { session } = entry;
    if (
      session.scope.tenantId !== scope.tenantId ||
      session.scope.apiKeyId !== scope.apiKeyId ||
      session.scope.providerId !== scope.providerId ||
      session.scope.providerAccountId !== scope.providerAccountId
    ) {
      return undefined;
    }
    const call = session.calls.get(callId);
    if (call === undefined) return undefined;
    return { session, call };
  }

  /** Clears one pending call after its result has been written to the Run. */
  clearPendingCall(runId: string, callId: string): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    const call = entry.session.calls.get(callId);
    if (call !== undefined) entry.session.pending.delete(call.execId);
    entry.session.calls.delete(callId);
    this.callOwners.delete(callId);
    this.touch(runId);
  }

  /** Extends one Run's idle expiry: the client answered, so the Run is live. */
  touch(runId: string, idleTtlMs = RUN_IDLE_TTL_MS): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    clearTimeout(entry.expiryTimer);
    entry.expiresAt = Date.now() + idleTtlMs;
    entry.expiryTimer = setTimeout(() => {
      this.terminate(runId, "Cursor Run idle-expired waiting for a tool result");
    }, idleTtlMs);
    entry.expiryTimer.unref?.();
  }

  /** Records the Run's authoritative terminal usage before it is closed. */
  recordUsage(runId: string, usage: UsageRecord): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    entry.session.usage = usage;
  }

  /** Records why a Run failed, so the next request reports it rather than hanging. */
  recordFailure(runId: string, failure: GatewayError): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    entry.session.failure = failure;
  }

  /** Reads one live Run by id, for the frame continuation path. */
  get(runId: string): CursorRunSession | undefined {
    return this.runs.get(runId)?.session;
  }

  /**
   * Describes one pending call by id and caller identity.
   *
   * The routing layer needs the owning account *before* it knows which provider
   * a candidate belongs to, so this reads the same server-recorded scope the
   * adapter will later re-check: tenant and API key here, provider and account
   * in the answer. A call id from another tenant or key resolves nothing.
   */
  describePendingCall(
    callId: string,
    scope: { readonly tenantId: string; readonly apiKeyId: string },
  ): { readonly providerId: string; readonly providerAccountId: string } | undefined {
    const runId = this.callOwners.get(callId);
    if (runId === undefined) return undefined;
    const entry = this.runs.get(runId);
    if (entry === undefined) return undefined;
    const { session } = entry;
    if (
      session.scope.tenantId !== scope.tenantId ||
      session.scope.apiKeyId !== scope.apiKeyId
    ) {
      return undefined;
    }
    if (!session.calls.has(callId)) return undefined;
    return {
      providerId: session.scope.providerId,
      providerAccountId: session.scope.providerAccountId,
    };
  }

  /**
   * Takes over the borrowed lease for a Run that is already registered.
   *
   * Idempotent: a second transfer stores nothing, so a retry of the same
   * continuation request cannot double-release the slot.
   */
  adoptLease(runId: string, ownership: AttemptLeaseOwnership | undefined): void {
    if (ownership === undefined) return;
    const entry = this.runs.get(runId);
    if (entry === undefined || entry.releaseLease !== undefined) return;
    const release = ownership.transferToProviderSession();
    if (release === undefined) return;
    entry.releaseLease = release;
  }

  /** Drops every live Run. Shutdown and test seam. */
  terminateAll(reason?: string): void {
    for (const runId of [...this.runs.keys()]) this.terminate(runId, reason);
    this.callOwners.clear();
  }
}

/** Process-local manager: one active Run set per gateway process. */
export const cursorRunSessions = new CursorRunSessionManager();
