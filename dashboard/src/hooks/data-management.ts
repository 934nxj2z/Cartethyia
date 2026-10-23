import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type {
  DiskUsageResponse,
  FlushResponse,
  PurgeResponse,
  ReclaimAction,
  ReclaimResponse,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../data/assert";
import { DASHBOARD_QUERY_OPTIONS, POLL } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * On-disk sizes, and the two housekeeping actions.
 *
 * Usage goes stale on its own, unlike the runtime settings which change only
 * through their own mutation: a compaction sweep or a reclaim changes these
 * numbers without the dashboard doing anything. So it re-reads on the status
 * cadence rather than being cached for minutes, and can be refreshed on demand.
 */
export function useDiskUsage() {
  return useQuery<DiskUsageResponse, ApiErrorShape>({
    queryKey: queryKeys.settings.diskUsage,
    queryFn: (context) =>
      consoleRequest<DiskUsageResponse>("/data-management/usage", {
        signal: querySignal(context),
      }),
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: POLL.status,
  });
}

/** Drops files the gateway no longer reads. Refreshes the sizes afterwards. */
export function useReclaimDisk() {
  const queryClient = useQueryClient();
  return useMutation<ReclaimResponse, ApiErrorShape, ReclaimAction>({
    mutationFn: (action) =>
      consoleRequest<ReclaimResponse>("/data-management/reclaim", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    onSuccess: async () => {
      // The sizes changed, so the panel must not keep showing the old totals.
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.diskUsage });
    },
  });
}

/** Drains the queued telemetry, usage, and health writers. */
export function useFlushBuffers() {
  return useMutation<FlushResponse, ApiErrorShape, void>({
    mutationFn: () =>
      consoleRequest<FlushResponse>("/data-management/flush", { method: "POST" }),
  });
}

/**
 * Deletes every stored health & error row.
 *
 * Confirm-then-run on the caller's side, like reclaim: the trail is the only
 * record of why an account transitioned, and it cannot be restored. The count
 * on the response is what the toast reports.
 */
export function usePurgeHealthEvents() {
  const queryClient = useQueryClient();
  return useMutation<PurgeResponse, ApiErrorShape, void>({
    mutationFn: () =>
      consoleRequest<PurgeResponse>("/data-management/purge", {
        method: "POST",
        body: JSON.stringify({ target: "health_events" }),
      }),
    onSuccess: async () => {
      // The purge row's count must not keep showing the old total.
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.diskUsage });
    },
  });
}
