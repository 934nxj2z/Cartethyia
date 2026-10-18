/**
 * The persisted slice of the server-state cache.
 *
 * IndexedDB, not `localStorage`: `/providers/models/flat` is megabytes on a
 * real catalog and `localStorage` is ~5 MB and synchronous — a quota failure
 * there would also take out the settings stored beside it, and every write
 * would block the main thread for the whole payload.
 *
 * Hand-rolled rather than `@tanstack/query-persist-client`, which is not
 * installed. `dehydrate`/`hydrate` come from `@tanstack/react-query` itself, so
 * the stored shape is TanStack's own `DehydratedState` and stays compatible if
 * the dependency is ever added; only the storage and the subscription are ours.
 */
import { dehydrate, hydrate, type DehydratedState } from "@tanstack/react-query";

const DB_NAME = "cartethyia.query-cache";
const STORE = "client";
const RECORD_KEY = "default";
const DB_VERSION = 1;

/**
 * Bumped whenever the allowlist or the stored shape changes, so a snapshot
 * written by an older build cannot be read back into a different one — the
 * cheapest way to guarantee a stale allowlist never survives a deploy.
 */
export const PERSIST_VERSION = 1;

interface StoredSnapshot {
  readonly version: number;
  readonly state: DehydratedState;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open the query cache."));
  return promise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("The query cache rejected the request."));
  return promise;
}

function transactionDone(tx: IDBTransaction, failure: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error(failure));
  return promise;
}

/** True when a stored record has the shape this build writes. */
function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (value === null || typeof value !== "object") return false;
  if (!("version" in value) || !("state" in value)) return false;
  const { version, state } = value as { version: unknown; state: unknown };
  return version === PERSIST_VERSION && state !== null && typeof state === "object";
}

/**
 * Storage is best-effort in both directions.
 *
 * A write that fails — quota, a private-mode browser, a corrupt store — costs a
 * cache miss on the next load, which is exactly what a first visit looks like.
 * A read that fails must be indistinguishable from "never stored", or one bad
 * record would keep the dashboard from ever starting.
 */
export async function persistClient(state: DehydratedState): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        { version: PERSIST_VERSION, state } satisfies StoredSnapshot,
        RECORD_KEY,
      );
      await transactionDone(tx, "Could not store the query cache.");
    } finally {
      db.close();
    }
  } catch {
    // See above: a failed write is a cache miss, not an error.
  }
}

/** `undefined` when nothing was stored, or what was stored is unusable. */
export async function restoreClient(): Promise<DehydratedState | undefined> {
  try {
    const db = await openDb();
    try {
      const stored = await requestToPromise(
        db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY),
      );
      return isStoredSnapshot(stored) ? stored.state : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function removeClient(): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(RECORD_KEY);
      await transactionDone(tx, "Could not remove the query cache.");
    } finally {
      db.close();
    }
  } catch {
    // A store that cannot be cleared is still overwritten on the next persist,
    // and the in-memory cache is already gone by the time this runs.
  }
}

/** Dehydrates a client into the bytes this module stores. */
export { dehydrate, hydrate };
