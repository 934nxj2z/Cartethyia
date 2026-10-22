import { Activity, CalendarDays, FileClock, FileJson, HardDrive, HardDriveDownload, Trash2, Zap, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { Banner } from "../../components/patterns/banner";
import { formatBytes, formatNumber } from "../../lib/format/numbers";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
import { useDiskUsage, useFlushBuffers, usePurgeHealthEvents, useReclaimDisk } from "../../hooks/data-management";
import type { DiskUsageBucket, ReclaimAction } from "../../data/contracts";

/**
 * What is on disk, and two ways to act on it.
 *
 * The sizes exist to answer a question the operator cannot otherwise get: how
 * much space is this data actually taking, and how much of it is dead weight.
 * Each row therefore says what the data is *for*, because "412 MB" is only
 * actionable once you know whether deleting it costs you the request list or
 * nothing.
 *
 * Reclaim is confirm-then-run rather than immediate. Deleting is not
 * reversible, and the button sits next to a number the operator may have only
 * glanced at.
 */
export function DataManagementPanel(): ReactNode {
  const usage = useDiskUsage();
  const reclaim = useReclaimDisk();
  const flush = useFlushBuffers();
  const purge = usePurgeHealthEvents();
  const [confirming, setConfirming] = useState<ReclaimAction | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  if (usage.isPending) return <LoadingState label="Measuring disk usage…" />;
  if (usage.isError || !usage.data) {
    return (
      <ErrorState
        message={getErrorMessage(usage.error, "Failed to measure disk usage")}
        onRetry={() => void usage.refetch()}
      />
    );
  }
  const data = usage.data;

  const run = (action: ReclaimAction | null): void => {
    if (action === null) return;
    setConfirming(null);
    reclaim.mutate(action, {
      onSuccess: (result) => {
        if (result.deletedFiles === 0) {
          toast.success("Nothing to reclaim.");
          return;
        }
        toast.success(
          `Reclaimed ${formatBytes(result.reclaimedBytes)} across ${formatNumber(
            result.deletedFiles,
          )} file${result.deletedFiles === 1 ? "" : "s"}.`,
        );
      },
      onError: (error) => toast.error(getErrorMessage(error, "Reclaim failed.")),
    });
  };

  const healthEventCount = data.healthEventCount;

  return (
    <Stack gap="14px">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <span className="text-caption text-text-tertiary">
          {formatBytes(data.totalBytes)} on disk across{" "}
          {formatNumber(data.buckets.reduce((sum, b) => sum + b.files, 0))} files
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon={<HardDrive size={14} />}
          onClick={() => void usage.refetch()}
          disabled={usage.isFetching}
        >
          {usage.isFetching ? "Measuring…" : "Refresh"}
        </Button>
      </div>

      {/*
       * A grid of cards, so the three buckets can be compared at a glance
       * instead of read as prose. Each card is the same shape — label, size,
       * count, action — which is what makes the numbers scannable.
       *
       * Hourly files carry no reclaim action: the backend refuses to delete
       * them, so the card says why instead of offering a button that fails.
       */}
      <div className="grid grid-cols-3 gap-6 w-full min-w-0 max-medium:grid-cols-1">
        {data.buckets.map((bucket) => {
          const action = reclaimActionFor(bucket);
          return (
            <BucketCard
              key={bucket.id}
              bucket={bucket}
              busy={reclaim.isPending}
              confirming={action !== null && confirming === action}
              onAsk={() => setConfirming(action)}
              onCancel={() => setConfirming(null)}
              onConfirm={() => run(action)}
            />
          );
        })}
      </div>

      <div
        data-bucket="health_events"
        className="flex items-center justify-between gap-6 rounded-control border border-inner-border px-6 py-5"
      >
        <span className="min-w-0 flex items-center gap-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
            <Activity size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <strong className="block text-body">Health &amp; Error Log</strong>
            <small className="text-caption text-text-tertiary">
              {healthEventCount === undefined
                ? "Purging is not offered in this deployment's console composition."
                : `${formatNumber(healthEventCount)} recorded transition${healthEventCount === 1 ? "" : "s"} across accounts and pools. Purge clears only this audit trail — account statuses and cooldowns stay as they are, and this cannot be undone.`}
            </small>
          </span>
        </span>
        {healthEventCount !== undefined ? (
          confirmingPurge ? (
            <span className="shrink-0 flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => setConfirmingPurge(false)} disabled={purge.isPending}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                disabled={purge.isPending}
                onClick={() =>
                  purge.mutate(undefined, {
                    onSuccess: (result) => {
                      setConfirmingPurge(false);
                      toast.success(
                        result.deleted === 0
                          ? "Health & error log was already empty."
                          : `Purged ${formatNumber(result.deleted)} health event${result.deleted === 1 ? "" : "s"}.`,
                      );
                    },
                    onError: (error) => toast.error(getErrorMessage(error, "Purge failed.")),
                  })
                }
              >
                Delete
              </Button>
            </span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              icon={<Trash2 size={14} />}
              disabled={purge.isPending || healthEventCount === 0}
              onClick={() => setConfirmingPurge(true)}
            >
              Purge
            </Button>
          )
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-6 rounded-control border border-inner-border px-6 py-5">
        <span className="min-w-0 flex items-center gap-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
            <HardDriveDownload size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <strong className="block text-body">Flush pending writes</strong>
            <small className="text-caption text-text-tertiary">
              Write queued telemetry, usage, and health events now instead of waiting for
              the interval. Nothing is deleted.
            </small>
          </span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon={<Zap size={14} />}
          disabled={flush.isPending}
          onClick={() =>
            flush.mutate(undefined, {
              onSuccess: () => toast.success("Buffers flushed."),
              onError: (error) => toast.error(getErrorMessage(error, "Flush failed.")),
            })
          }
        >
          {flush.isPending ? "Flushing…" : "Flush"}
        </Button>
      </div>

      {reclaim.isError ? (
        <Banner tone="danger" surface="raised" live="status">
          {getErrorMessage(reclaim.error, "Reclaim failed.")}
        </Banner>
      ) : null}
    </Stack>
  );
}

/**
 * Which reclaim each bucket offers. Hourly files have none: they are the only
 * copy of their requests until compaction folds them up, so the backend
 * refuses to delete them and the row says so rather than offering a dead
 * button.
 */
function reclaimActionFor(bucket: DiskUsageBucket): ReclaimAction | null {
  if (bucket.id === "payload_frames") return "payload_frames";
  if (bucket.id === "telemetry_compacted") return "telemetry_retention";
  return null;
}

/** One glyph per section, so the five parts of the panel read as a family. */
function bucketIconFor(bucket: DiskUsageBucket): LucideIcon {
  if (bucket.id === "payload_frames") return FileJson;
  if (bucket.id === "telemetry_compacted") return CalendarDays;
  return FileClock;
}

/**
 * One bucket, as a card.
 *
 * Size first: it is the number the operator came for, so it leads. The note is
 * one line because three of these sit side by side — a paragraph in each turns
 * the grid back into prose.
 */
function BucketCard({
  bucket,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly bucket: DiskUsageBucket;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const action = reclaimActionFor(bucket);
  const reclaimable = bucket.reclaimableBytes ?? 0;
  const files = bucket.reclaimableFiles ?? 0;
  const nothingToReclaim = action !== null && reclaimable === 0;
  const Icon = bucketIconFor(bucket);

  return (
    // `data-bucket` names the card, so a test asks for the card itself instead
    // of walking up from whichever nested element happened to hold the label.
    <div
      data-bucket={bucket.id}
      className="flex flex-col rounded-control border border-inner-border px-6 py-5 min-w-0"
    >
      <span className="flex items-start gap-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-caption text-text-tertiary">{bucket.label}</span>
          <span className="mt-1 block text-lead font-semibold text-text-primary">
            {formatBytes(bucket.bytes)}
          </span>
          <span className="block text-caption text-text-tertiary">
            {formatNumber(bucket.files)} file{bucket.files === 1 ? "" : "s"} · {bucket.note}
          </span>
        </span>
      </span>

      {/*
       * Pinned to the bottom so the three cards' actions line up even when
       * their notes wrap to different heights.
       */}
      <div className="mt-auto pt-5">
        {action === null ? (
          <p className="text-caption text-text-tertiary">Kept — no other copy.</p>
        ) : confirming ? (
          <span className="flex flex-col gap-3">
            <span className="text-caption text-text-secondary">
              Delete {formatNumber(files)} file{files === 1 ? "" : "s"},{" "}
              {formatBytes(reclaimable)}?
            </span>
            <span className="flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={onConfirm}
                disabled={busy}
              >
                Delete
              </Button>
            </span>
          </span>
        ) : (
          <span className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-caption text-text-tertiary">
              {nothingToReclaim ? "Clean" : `${formatBytes(reclaimable)} free`}
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={onAsk}
              disabled={busy || nothingToReclaim}
            >
              Reclaim
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
