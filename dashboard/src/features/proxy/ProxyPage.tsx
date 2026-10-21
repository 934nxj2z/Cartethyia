import { useProviderProbeNetworkPool } from "../../hooks/network";
import {
  Activity,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  Gauge,
  Loader2,
  Plus,
  Power,
  Pencil,
  PowerOff,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { RelayDeployModal } from "../../components/RelayDeployPanel";
import { useMaskIp, usePrivacyMode } from "../../lib/privacy-mode";
import { liveProbeFor, type StoredProviderResult } from "./probe-freshness";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { DataTable, StatCard } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Select } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "../../data/contracts";
import type {
  HealthCheckResult,
  NetworkPoolResponse,
  PoolProviderProbeResult,
  PoolSpeedTestResult,
} from "../../data/contracts";
import {
  useCreateNetworkPool,
  useDeleteNetworkPool,
  useHealthCheckNetworkPool,
  useNetworkPoolHealthEvents,
  useNetworkPools,
  useProbeNetworkPoolBatch,
  useProbeAdHocProviderBatch,
  useRecoverNetworkPool,
  useSpeedTestNetworkPool,
  useUpdateNetworkPool,
  useClearNetworkPoolCooldown,
} from "../../hooks/network";
import { usePoolUsage, type PoolUsageRow } from "../../hooks/live";
import {
  MAX_BATCH_PROBE_TARGETS,
  sortPools,
  summarizePools,
  type PoolSortKey,
  type ProxyPoolSummary,
} from "./proxy-metrics";
import {
  SCHEME_CHIPS,
  type SchemeChip,
  applySchemeChip,
  chipTargetLine,
  detectProxyKind,
  parseQuotaGb,
  splitQuotaAcrossFamily,
} from "./proxy-endpoint";
import { formatBytes } from "../../lib/format/numbers";
import { downloadTextFile } from "../../lib/download";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
const BULK_POOL_CREATE_CONCURRENCY = 4;

/**
 * What the split Test control sends.
 *
 * `url` is the neutral Cloudflare canary: it proves the proxy carries traffic
 * and reports the egress address, which is what the table column shows.
 * `opencode` asks the provider itself, because OpenCode refuses a flagged
 * address on its dispatch route while still serving its public catalog from
 * the same address — a neutral probe cannot see that.
 */
type TestPayload = "url" | "opencode";
const TEST_PAYLOAD_STORAGE_KEY = "cartethyia_proxy_test_payload";
const CHECK_RESULTS_STORAGE_KEY = "cartethyia_proxy_check_results";

const TEST_PAYLOAD_OPTIONS = [
  { value: "url", label: "Test URL" },
  { value: "opencode", label: "Test OpenCode" },
];

/** The provider the OpenCode payload asks. */
const PROBE_PROVIDER_ID = "opencode";
/**
 * How many provider probes run at once.
 *
 * Lower than the health check's eight: each probe opens a tunnel and a TLS
 * session to the provider, and a wide fan-out across a large selection is what
 * makes a batch probe look like an outage from the upstream's side.
 */
const PROVIDER_PROBE_CONCURRENCY = 4;

const MYSTERIOUS_PROXY = "Mysterious Proxy";


/** Averages are only meaningful once something has been measured; say so
 * plainly instead of showing a confident `0ms`. */
function latencyDetail(summary: ProxyPoolSummary): string {
  if (summary.avgLatencyMs === null) return "no measurement yet";
  return `avg across ${summary.measuredPools} enabled ${summary.measuredPools === 1 ? "pool" : "pools"}`;
}

/** Derives a friendly `host:port` name and a normalized full endpoint URL from a pool. */
function poolDisplay(pool: NetworkPoolResponse): { name: string; endpoint: string } {
  const raw = pool.endpoint || "";
  const candidate = raw.includes("://") ? raw : `${pool.kind}://${raw}`;
  const defaultPorts: Record<string, string> = {
    "https:": "443",
    "http:": "80",
    "socks5:": "1080",
    "socks:": "1080",
  };
  try {
    const u = new URL(candidate);
    const port = u.port || defaultPorts[u.protocol] || "";
    const authority = `${u.hostname}${port ? `:${port}` : ""}`;
    return {
      name: authority,
      endpoint: `${u.protocol}//${authority}${u.pathname !== "/" ? u.pathname : ""}${u.search}`,
    };
  } catch {
    return { name: pool.label || raw, endpoint: raw };
  }
}

/** Human-friendly pool name: explicit label first, then the derived `host:port`. */
function poolName(pool: NetworkPoolResponse): string {
  return pool.label || poolDisplay(pool).name || pool.id;
}

const GIB = 1024 ** 3;
// A measurement plus when it was taken. The server now stamps and persists
// each speed test on the pool row (`measuredAt` + `lastSpeedtest*`), so the
// localStorage entry is only a fallback for the just-measured moment before
// the pool list refetches — the server row is the authority after any reload.
type StoredSpeedResult = PoolSpeedTestResult & { readonly measuredAt?: string };

/** Last server-persisted speed-test measurement for a pool, if any. */
function serverSpeedResult(pool: NetworkPoolResponse): StoredSpeedResult | undefined {
  if (pool.lastSpeedtestStatus === undefined || pool.lastSpeedtestAt === undefined) return undefined;
  const durationMs = pool.lastSpeedtestDurationMs ?? 0;
  const bytes = pool.lastSpeedtestBytes ?? 0;
  const bytesPerSecond = durationMs > 0 ? bytes / (durationMs / 1000) : undefined;
  return {
    poolId: pool.id,
    status: pool.lastSpeedtestStatus,
    bytes,
    durationMs,
    ...(bytesPerSecond === undefined
      ? {}
      : { bytesPerSecond, megabitsPerSecond: (bytesPerSecond * 8) / 1_000_000 }),
    ...(pool.lastSpeedtestError ? { errorMessage: pool.lastSpeedtestError } : {}),
    measuredAt: pool.lastSpeedtestAt,
  };
}

/** Newer of the local and server-known measurements wins. */
function newerSpeedResult(
  local: StoredSpeedResult | undefined,
  server: StoredSpeedResult | undefined,
): StoredSpeedResult | undefined {
  if (!local) return server;
  if (!server) return local;
  const localAt = local.measuredAt ? new Date(local.measuredAt).getTime() : 0;
  const serverAt = server.measuredAt ? new Date(server.measuredAt).getTime() : 0;
  return serverAt >= localAt ? server : local;
}
// Payload choices for the speed-test split control. Labels are decimal MB
// (1 MB = 1_000_000 bytes) to match how proxy plans are sold.
const SPEED_TEST_SIZES = [
  { value: String(SPEED_TEST_MIN_BYTES), label: "1 MB" },
  { value: String(SPEED_TEST_DEFAULT_BYTES), label: "5 MB" },
  { value: String(50_000_000), label: "50 MB" },
  { value: String(SPEED_TEST_MAX_BYTES), label: "100 MB" },
];
function PoolEditForm({
  pool,
  onClose,
  actionsRef,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
  readonly actionsRef?: (actions: ReactNode) => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const adhocProviderProbe = useProbeAdHocProviderBatch();
  const healthCheck = useHealthCheckNetworkPool();
  const [label, setLabel] = useState(pool.label ?? "");
  const [family, setFamily] = useState(pool.family ?? "");
  const [endpoint, setEndpoint] = useState(pool.endpoint ?? "");
  const [cap, setCap] = useState(String(pool.maxInflight ?? 10));
  const [weight, setWeight] = useState(String(pool.weight ?? 100));
  // Quota is entered in GB because that is how providers sell it; it is stored
  // in bytes so the usage bar can compare without a lossy round-trip.
  const [quotaGb, setQuotaGb] = useState(
    pool.quotaBytes ? String(Math.round((pool.quotaBytes / GIB) * 1000) / 1000) : "",
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  /**
   * Tests the endpoint **in the form**, not the one stored on the row.
   *
   * `healthCheck(pool.id)` dialed the saved endpoint, so an operator who pasted
   * a new proxy and pressed Test was told about the old one — and the answer
   * looked authoritative. The provider probe has an ad-hoc form for exactly
   * this: it builds the pool from the request body, so the verdict describes
   * what the operator is about to save.
   *
   * A stored credential cannot ride along — the ad-hoc form never carries one,
   * by design, because the console never sends a secret back to the browser.
   * For an unchanged endpoint on a credentialed pool the saved row is the only
   * thing that can authenticate, so that case keeps using the health check.
   */
  const endpointUnchanged = endpoint.trim() === pool.endpoint;
  const runAdhocTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (endpointUnchanged) {
        const health = await healthCheck.mutateAsync(pool.id);
        const ok = health.status === "healthy" || health.status === "reachable";
        setTestResult({
          ok,
          message:
            health.status === "healthy"
              ? `Connected in ${health.latencyMs ?? 0}ms`
              : health.errorMessage ?? "Connection failed",
        });
        return;
      }
      const targets = [
        {
          kind: pool.kind,
          endpoint: endpoint.trim(),
          ...(pool.family === null || pool.family === undefined ? {} : { family: pool.family }),
        },
      ];
      const [batch] = await adhocProviderProbe.mutateAsync({
        providerId: PROBE_PROVIDER_ID,
        targets: targets as never,
      });
      const result = batch?.result;
      if (!result) {
        setTestResult({ ok: false, message: "Probe returned no result" });
        return;
      }
      const ok = result.status === "allowed" || result.status === "throttled";
      setTestResult({
        ok,
        message:
          result.reason ??
          (result.status === "allowed"
            ? `Reachable${result.latencyMs === undefined ? "" : ` in ${result.latencyMs}ms`}`
            : result.status === "throttled"
              ? "Reachable; rate limit spent"
              : "Probe could not complete"),
      });
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Connection failed") });
    } finally {
      setTesting(false);
    }
  };

  const quotaValue = parseQuotaGb(quotaGb);

  const save = async () => {
    await updatePool.mutateAsync({
      poolId: pool.id,
      request: {
        ...(label.trim() !== pool.label ? { label: label.trim() || undefined } : {}),
        // An emptied box clears the tag, so compare against the raw stored
        // value rather than a trimmed one.
        ...(family.trim() !== (pool.family ?? "") ? { family: family.trim() || null } : {}),
        ...(endpoint.trim() !== pool.endpoint && endpoint.trim() !== ""
          ? { endpoint: endpoint.trim() }
          : {}),
        ...(Number(cap) !== pool.maxInflight ? { maxInflight: Number(cap) } : {}),
        ...(Number(weight) !== pool.weight ? { weight: Number(weight) } : {}),
        ...(quotaValue !== (pool.quotaBytes ?? null) ? { quotaBytes: quotaValue } : {}),
      },
    });
    toast.success("Proxy updated");
    onClose();
  };

  useEffect(() => {
    actionsRef?.(
      <>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={updatePool.isPending || !endpoint.trim()} onClick={() => void save()}>Save</Button>
      </>
    );
  });
  return (
    <Stack gap="12px">
      <div>
        <Input
          label="Name"
          value={label}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
        />
      </div>
      <div>
        <Input
          label="Family"
          value={family}
          placeholder="e.g. residential-id"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFamily(e.target.value)}
        />
      </div>
      <div>
        <Input
          label="Endpoint"
          value={endpoint}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndpoint(e.target.value)}
          className="font-mono tabular-nums"
        />
      </div>
      <div className="grid grid-cols-2 gap-5">
        <div>
          <Input
            label="Max concurrent"
            type="number"
            min={1}
            value={cap}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCap(e.target.value)}
          />
        </div>
        <div>
          <Input
            label="Weight"
            type="number"
            min={1}
            value={weight}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWeight(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Input
          label="Bandwidth quota (GB, blank = unmetered)"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
        />
        <div className="text-micro text-text-tertiary mt-2">
          {quotaValue === null
            ? "No quota — the bar shows a running total only."
            : `Bar turns orange at 80% and red once ${formatBytes(quotaValue)} is exceeded.`}
        </div>
      </div>
      {testResult && (
        <div
          // The connection outcome is read from the test result, so its fill
          // and ink are chosen at render time.
          className={`rounded-inset px-6 py-4 text-badge font-semibold ${testResult.ok ? "bg-green-soft text-green" : "bg-red-soft text-red"}`}
        >
          {testResult.message}
        </div>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={testing}
          icon={testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
          onClick={() => void runAdhocTest()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </Stack>
  );
}
/**
 * The scheme chips row, extracted so it can be rendered directly with props.
 *
 * Rendering the whole batch form to test a chip means driving a textarea's
 * value through happy-dom, and React's synthetic `onChange` does not fire there
 * — so the chip's behaviour (which scheme is pressed, what preview appears) is
 * asserted against this component with explicit props instead.
 *
 * `endpoint` is the first non-empty paste line, or undefined on an empty paste.
 * The chips are disabled until it exists, and an explicit scheme on that line
 * always wins inside `applySchemeChip`, so a chip never masks a host the
 * operator already wrote.
 */
export function SchemeChipRow({
  endpoint,
  chip,
  onChipChange,
}: {
  readonly endpoint: string | undefined;
  readonly chip: SchemeChip | null;
  readonly onChipChange: (chip: SchemeChip | null) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Scheme for the first endpoint">
      <span className="text-badge text-text-secondary">Scheme</span>
      {SCHEME_CHIPS.map((scheme) => {
        const active = chip === scheme;
        return (
          <Button
            key={scheme}
            type="button"
            variant={active ? "primary" : "secondary"}
            size="sm"
            disabled={endpoint === undefined}
            aria-pressed={active}
            data-scheme={scheme}
            onClick={() => onChipChange(active ? null : scheme)}
            className="font-mono"
          >
            {scheme}://
          </Button>
        );
      })}
      {chip !== null && (
        <span className="text-badge text-text-tertiary">
          → {applySchemeChip(endpoint ?? "", chip)}
        </span>
      )}
    </div>
  );
}
export function ProxyBulkForm({
  onClose,
  actionsRef,
  onProbeResult,
  onHealthResult,
}: {
  readonly onClose: () => void;
  readonly actionsRef?: (actions: ReactNode) => void;
  /** Hands a provider-probe verdict to the page once the pool row exists. */
  readonly onProbeResult?: (poolId: string, result: PoolProviderProbeResult) => void;
  /** Hands the URL test's verdict along with it, so both survive the save. */
  readonly onHealthResult?: (poolId: string, result: HealthCheckResult) => void;
}): ReactNode {
  const createPool = useCreateNetworkPool();
  const probeBatch = useProbeNetworkPoolBatch();
  const probeProviderBatch = useProbeAdHocProviderBatch();
  const [text, setText] = useState("");
  const [family, setFamily] = useState("");
  const [quotaGb, setQuotaGb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // Keyed by endpoint so a row can inherit the verdict once the pool exists.
  const [probeByEndpoint, setProbeByEndpoint] = useState<Record<string, PoolProviderProbeResult>>({});
  // The URL test's verdict, kept beside it. The two answer different questions
  // — "does this tunnel carry traffic" and "will this provider serve it" — and
  // an operator who ran both expects the saved row to show both, not just the
  // second one.
  const [healthByEndpoint, setHealthByEndpoint] = useState<Record<string, HealthCheckResult>>({});
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  // Scheme chip applies to the first non-empty line only, exactly as the
  // operator reads the paste: one prefix choice for the batch.
  const [chip, setChip] = useState<SchemeChip | null>(null);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // The chip prefixes the first line; an explicit scheme on that line always
  // wins, so a chip never masks what the operator already wrote.
  const firstLine = chipTargetLine(lines);
  const chippedLines = useMemo(() => {
    if (chip === null || firstLine === undefined) return lines;
    return lines.map((line, index) => (line === firstLine && index === 0 ? applySchemeChip(line, chip) : line));
  }, [lines, chip, firstLine]);
  const overCap = lines.length > MAX_BATCH_PROBE_TARGETS;
  const quotaBytes = parseQuotaGb(quotaGb);
  const targets = useMemo(
    () => chippedLines.map((line) => ({ kind: detectProxyKind(line), endpoint: line })),
    [chippedLines],
  );

  const handlePaste = async () => {
    try {
      const v = await navigator.clipboard.readText();
      if (v) setText((p) => (p ? `${p}\n${v}` : v));
    } catch {
      toast.error("Paste failed", "Clipboard access denied");
    }
  };

  /**
   * Probes every pasted endpoint in one batched request.
   *
   * Reports the egress address alongside latency, because the address is what
   * the table shows after the rows are saved — an operator testing before
   * adding wants to see the same two facts the table will carry.
   */
  const runTestUrl = async () => {
    if (targets.length === 0) return;
    setLog([`Testing ${targets.length} proxy target(s)…`]);
    try {
      const results = await probeBatch.mutateAsync(targets);
      const rows = results.map((entry) => {
        const ok = entry.result.status === "healthy" || entry.result.status === "reachable";
        const latency = entry.result.latencyMs === undefined ? "" : ` · ${entry.result.latencyMs}ms`;
        const egress = entry.result.egressIp ? ` · ${entry.result.egressIp}` : "";
        const detail = ok ? "" : ` · ${entry.result.errorMessage ?? entry.result.status}`;
        return `${ok ? "OK  " : "FAIL"} ${entry.endpoint}${latency}${egress}${detail}`;
      });
      const okCount = results.filter(
        (r) => r.result.status === "healthy" || r.result.status === "reachable",
      ).length;
      setHealthByEndpoint((prev) => {
        const next = { ...prev };
        for (const entry of results) next[entry.endpoint] = entry.result;
        return next;
      });
      setLog([`${okCount}/${results.length} reachable`, ...rows]);
      if (okCount === results.length) toast.success(`All ${results.length} proxies reachable`);
      else toast.error(`${results.length - okCount} of ${results.length} proxies failed`);
    } catch (err) {
      setLog([`Test failed: ${getErrorMessage(err, "batch probe failed")}`]);
      toast.error("Test failed", getErrorMessage(err, "batch probe failed"));
    }
  };

  /**
   * Asks OpenCode, through each pasted endpoint, whether it will serve us.
   *
   * Separate from the URL test rather than a mode of it: the two answer
   * different questions, and an operator reading the log needs to know which
   * one produced a line. A blocked address still answers the URL test, so the
   * two results are not interchangeable.
   */
  const runTestOpencode = async () => {
    if (targets.length === 0) return;
    setLog([`Testing ${targets.length} proxy target(s) against OpenCode…`]);
    try {
      const results = await probeProviderBatch.mutateAsync({
        providerId: PROBE_PROVIDER_ID,
        targets,
      });
      const rows = results.map((entry) => {
        const { status, latencyMs, reason } = entry.result;
        const latency = latencyMs === undefined ? "" : ` · ${latencyMs}ms`;
        const detail = reason === undefined ? "" : ` · ${reason}`;
        return `${status === "allowed" ? "OK  " : status === "blocked" ? "BLOCK" : "FAIL"} ${entry.endpoint}${latency}${detail}`;
      });
      setProbeByEndpoint((prev) => {
        const next = { ...prev };
        for (const entry of results) next[entry.endpoint] = entry.result;
        return next;
      });
      const allowed = results.filter((r) => r.result.status === "allowed").length;
      const blocked = results.filter((r) => r.result.status === "blocked").length;
      setLog([`${allowed}/${results.length} allowed · ${blocked} blocked`, ...rows]);
      if (blocked === 0 && allowed === results.length) {
        toast.success(`OpenCode accepted all ${results.length} proxies`);
      } else {
        toast.error(`OpenCode: ${allowed} allowed · ${blocked} blocked`);
      }
    } catch (err) {
      setLog([`Test failed: ${getErrorMessage(err, "provider probe failed")}`]);
      toast.error("Test failed", getErrorMessage(err, "provider probe failed"));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) return;
    setError(null);
    setBatchSubmitting(true);
    try {
      // A shared pool, not a per-proxy allowance: every row that names the same
      // family draws from the one quota figure, so the operator's 100 GB means
      // 100 GB for that family — 5 endpoints share it at 20 GB each, not 100 GB
      // apiece. Rows with no family are outside any pool and take no quota.
      const perRowQuota =
        quotaBytes === null
          ? new Map<number, number>()
          : splitQuotaAcrossFamily(quotaBytes, family, chippedLines.length);
      const outcomes: Array<{ ok: boolean; error?: string }> = new Array(lines.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < lines.length) {
          const index = cursor++;
          const line = chippedLines[index]!;
          try {
            const created = await createPool.mutateAsync({
              kind: detectProxyKind(line),
              endpoint: line,
              ...(perRowQuota.has(index) ? { quotaBytes: perRowQuota.get(index) } : {}),
              ...(family.trim() !== "" ? { family: family.trim() } : {}),
            });
            // Carry both verdicts the operator already paid for onto the row
            // that now exists, so the table shows them without a re-test.
            const probed = probeByEndpoint[line];
            const health = healthByEndpoint[line];
            if (created?.id) {
              if (health !== undefined) onHealthResult?.(created.id, health);
              if (probed !== undefined) onProbeResult?.(created.id, probed);
            }
            outcomes[index] = { ok: true };
          } catch (err) {
            outcomes[index] = { ok: false, error: getErrorMessage(err, "Proxy pool creation failed") };
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(BULK_POOL_CREATE_CONCURRENCY, lines.length) },
          () => worker(),
        ),
      );

      const failures: string[] = [];
      let ok = 0;
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.ok) {
          ok++;
        } else if (failures.length < 3) {
          failures.push(`${lines[index]!.slice(0, 48)}…: ${outcome.error}`);
        }
      }
      const fail = lines.length - ok;
      const firstFailure = outcomes.find((outcome) => !outcome.ok)?.error;
      if (ok > 0) {
        toast.success(
          `Added ${ok} proxy pool(s)`,
          fail ? `${fail} failed: ${firstFailure ?? "see the import details"}` : undefined,
        );
      }
      if (fail > 0 && ok === 0) {
        toast.error("Failed to create pool", firstFailure ?? "See the import details");
      }
      if (fail > 0) setError(failures.join("\n"));
      if (ok > 0) {
        setText("");
        onClose();
      }
    } finally {
      setBatchSubmitting(false);
    }
  };

  useEffect(() => {
    actionsRef?.(
      <>
        <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="add-proxy-form" disabled={batchSubmitting || lines.length === 0}>
          {batchSubmitting ? "Adding…" : `Add ${lines.length} Prox${lines.length === 1 ? "y" : "ies"}`}
        </Button>
      </>
    );
  }, [actionsRef, batchSubmitting, lines.length, onClose]);
  return (
    <form id="add-proxy-form" onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="proxy-endpoints" className="text-caption font-semibold text-text-primary">
          Proxy endpoints
        </label>
        <Button variant="secondary" size="sm" type="button" onClick={handlePaste}>
          Paste
        </Button>
      </div>
      <textarea
        id="proxy-endpoints"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"http://proxy.example:8080\nhttps://proxy.example:8443\nsocks5://proxy.example:1080"}
        rows={5}
        aria-describedby="proxy-format-hint proxy-line-count"
        aria-invalid={Boolean(error)}
        className="w-full min-h-32 max-h-64 resize-y overflow-y-auto rounded-control border border-inner-border bg-surface-1 p-3 font-mono text-caption text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
      />
      <SchemeChipRow endpoint={firstLine} chip={chip} onChipChange={setChip} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p id="proxy-format-hint" className="m-0 text-badge leading-normal text-text-secondary">
          HTTP, HTTPS, or SOCKS5 | one per line | authentication optional
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span
            id="proxy-line-count"
            role="status"
            aria-live="polite"
            className={`text-badge ${overCap ? "text-red" : "text-text-tertiary"}`}
          >
            {lines.length === 1 ? "1 proxy detected" : `${lines.length} proxies detected`}
            {overCap ? ` · max ${MAX_BATCH_PROBE_TARGETS} per test` : ""}
          </span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void runTestUrl()}
            disabled={probeBatch.isPending || probeProviderBatch.isPending || lines.length === 0 || overCap}
          >
            {probeBatch.isPending ? "Testing…" : "Test URL"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void runTestOpencode()}
            disabled={probeBatch.isPending || probeProviderBatch.isPending || lines.length === 0 || overCap}
          >
            {probeProviderBatch.isPending ? "Testing…" : "Test OpenCode"}
          </Button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="max-h-28 overflow-y-auto rounded-inset bg-red-soft px-4 py-3 text-badge text-red whitespace-pre-wrap break-words"
        >
          {error}
        </div>
      )}
      {log.length > 0 && (
        <div
          role="log"
          aria-label="Proxy test results"
          aria-live="polite"
          className="scroll-region max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-inset border border-inner-border bg-surface-1 px-3 py-2 font-mono text-badge leading-[1.5] text-text-secondary"
        >
          {log.join("\n")}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          id="proxy-family"
          label="Family"
          hint="Optional"
          value={family}
          placeholder="e.g. residential-id"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFamily(e.target.value)}
          className="w-full"
        />
        <Input
          id="proxy-quota"
          label="Bandwidth quota (GB)"
          hint="Optional"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
          className="w-full"
        />
      </div>
    </form>
  );
}

function poolLatencyMs(
  pool: NetworkPoolResponse,
  checkResult?: HealthCheckResult,
): number | undefined {
  if (checkResult?.status === "healthy" || checkResult?.status === "reachable") {
    return checkResult.latencyMs;
  }
  if (pool.lastSuccessAt) return pool.lastLatencyMs ?? undefined;
  return undefined;
}
function proxyResponseLabel(category: string | undefined): string | undefined {
  if (category === "proxy_payment_required") return "HTTP 402 Payment Required";
  if (category === "proxy_auth_required") return "HTTP 407 Proxy Authentication Required";
  return undefined;
}


/**
 * Live per-pool usage, held above the page body.
 *
 * The stream ticks whenever a pool acquires or releases a slot. Subscribing in
 * the page component itself re-rendered the whole page — every row, every
 * handler — on each tick, which is what made a busy Proxy page feel heavy. The
 * subscription lives here instead and children pass through as a prop, so the
 * subtree stays referentially stable and a tick re-renders only the two
 * components that read this context. One stream per open page.
 */
const PoolUsageContext = createContext<{
  readonly byId: ReadonlyMap<string, PoolUsageRow>;
  readonly live: boolean;
}>({ byId: new Map(), live: false });

export function ProxyLiveProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const usage = usePoolUsage();
  const byId = useMemo(
    () => new Map((usage.pools ?? []).map((row) => [row.poolId, row] as const)),
    [usage.pools],
  );
  const value = useMemo(
    () => ({ byId, live: usage.live && usage.pools !== null }),
    [byId, usage.live, usage.pools],
  );
  return <PoolUsageContext.Provider value={value}>{children}</PoolUsageContext.Provider>;
}

/**
 * The four summary tiles. Split out because the live stream moves three of
 * them; keeping them in the page would re-render the table below on every tick.
 */
function ProxySummaryTiles({ pools }: { readonly pools: readonly NetworkPoolResponse[] }): ReactNode {
  const { byId, live } = useContext(PoolUsageContext);
  const summary = useMemo(
    () =>
      summarizePools(
        pools,
        live ? new Map([...byId].map(([id, row]) => [id, row.currentInflight] as const)) : undefined,
      ),
    [pools, byId, live],
  );
  // Cumulated metered usage across all proxies: the same max(metered, session)
  // rule as the per-row bar, so the tile and the rows can never disagree.
  const quota = useMemo(() => {
    let used = 0;
    let allowance = 0;
    for (const pool of pools) {
      const row = live ? byId.get(pool.id) : undefined;
      const metered = (pool.bytesSentTotal ?? 0) + (pool.bytesReceivedTotal ?? 0);
      const session = (row?.bytesSent ?? 0) + (row?.bytesReceived ?? 0);
      used += Math.max(metered, session);
      if (pool.quotaBytes) allowance += pool.quotaBytes;
    }
    return { used, allowance };
  }, [pools, byId, live]);
  return (
    <div
      className="signal-grid grid gap-7 w-full min-w-0 mb-7"
    >
      <StatCard
        label="Enabled pool"
        value={String(summary.active)}
        detail={`/ ${summary.totalPools} total`}
        tone="accent"
        icon={<ShieldCheck size={13} />}
      />
      <StatCard
        label="Route capacity"
        value={String(summary.totalMaxConcurrency)}
        detail={`${summary.usedInflight} inflight · ${summary.availableCapacity} available`}
        tone={summary.availableCapacity === 0 ? "orange" : "teal"}
        icon={<Gauge size={13} />}
      />
      <StatCard
        label="Latency"
        value={summary.avgLatencyMs === null ? "—" : `${summary.avgLatencyMs}ms`}
        detail={latencyDetail(summary)}
        tone={
          summary.avgLatencyMs === null
            ? "accent"
            : summary.avgLatencyMs > 2000
              ? "orange"
              : "teal"
        }
        icon={<Activity size={13} />}
      />
      <StatCard
        label="Quota usage"
        value={formatBytes(quota.used)}
        detail={
          quota.allowance > 0
            ? `of ${formatBytes(quota.allowance)} allowance · ${pools.length} pools`
            : `${pools.length} pools · no allowance set`
        }
        tone={quota.allowance > 0 && quota.used > quota.allowance ? "red" : quota.allowance > 0 && quota.used / quota.allowance >= 0.8 ? "orange" : "teal"}
        icon={<Cloud size={13} />}
      />
    </div>
  );
}

/**
 * Everything a pool row or card renders, derived in one place so the desktop
 * table and the mobile cards cannot disagree about status, load, or quota.
 */
interface PoolView {
  readonly display: { name: string; endpoint: string };
  readonly poolLabel: string;
  readonly isEnabled: boolean;
  readonly checkTone: BadgeTone;
  readonly checkTooltip: string | undefined;
  readonly statusText: string;
  readonly latency: number | undefined;
  readonly inflight: number;
  readonly load: number;
  readonly cooldowns: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly cooldownText: string;
  /** The last OpenCode probe for this pool, when one has run. */
  readonly probe?: PoolProviderProbeResult;
  /** Providers this egress is retired for, as opposed to merely throttled. */
  readonly blocked: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly cooldownOnly: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly metered: number;
  readonly session: number;
  readonly used: number;
  readonly proxyFailureLabel: string | undefined;
}

function derivePoolView(
  pool: NetworkPoolResponse,
  checkResult: HealthCheckResult | undefined,
  isTesting: boolean,
  liveBytes: PoolUsageRow | null,
  probe?: PoolProviderProbeResult,
): PoolView {
  const display = poolDisplay(pool);
  const poolLabel = poolName(pool);
  const isEnabled = pool.status !== "disabled";
  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const proxyResponseDisabled = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const lastSuccess = pool.lastSuccessAt ? new Date(pool.lastSuccessAt).getTime() : 0;
  const lastError = pool.lastErrorAt ? new Date(pool.lastErrorAt).getTime() : 0;
  const persistedOk =
    !checkResult && (lastSuccess > 0 || lastError > 0) ? lastSuccess >= lastError : null;
  const checkTone: BadgeTone = isTesting
    ? "default"
    : proxyResponseDisabled
      ? "warn"
      : checkResult
        ? checkResult.status === "healthy"
          ? "ok"
          : checkResult.status === "reachable"
            ? "warn"
            : "err"
        : persistedOk === true
          ? "ok"
          : persistedOk === false
            ? "err"
            : "default";
  const checkTooltip = proxyResponseDisabled
    ? pool.lastError ?? proxyFailureLabel
    : checkResult?.errorMessage ??
      (persistedOk !== null
        ? `last check ${(pool.lastHealthCheckAt ? new Date(pool.lastHealthCheckAt) : new Date()).toLocaleString()}`
        : undefined);
  const latency = poolLatencyMs(pool, checkResult);
  // Live SSE usage wins over the polled snapshot while the stream is up.
  const inflight = liveBytes?.currentInflight ?? pool.inflight;
  const load = pool.maxInflight > 0 ? Math.min(1, inflight / pool.maxInflight) : 1;
  const cooldowns = pool.providerCooldowns ?? [];
  // A block is not a cooldown with a longer clock: the upstream retired this
  // address, so it will not come back on its own. Rendering the two as one
  // number is what let an operator wait out something that never expires.
  const blocked = cooldowns.filter((entry) => entry.blocked === true);
  const cooldownOnly = cooldowns.filter((entry) => entry.blocked !== true);
  const describe = (entry: NonNullable<NetworkPoolResponse["providerCooldowns"]>[number]) =>
    entry.blocked === true
      ? `${entry.providerId} blocked: ${entry.reason}`
      : `${entry.providerId} until ${new Date(entry.until).toLocaleTimeString()}: ${entry.reason}`;
  const cooldownText = cooldowns.slice(0, 2).map(describe).join(" · ");
  const statusText = isTesting
    ? "Testing…"
    : proxyResponseDisabled
      ? "Proxy reachable"
      : checkResult
        ? checkResult.status === "healthy"
          ? "Connected"
          : checkResult.status === "reachable"
            ? "Proxy reachable"
            : checkResult.status === "timeout"
              ? "Timeout"
              : "Unhealthy"
        : persistedOk === true
          ? "Connected"
          : persistedOk === false
            ? pool.lastErrorCategory === "timeout"
              ? "Timeout"
              : "Unhealthy"
            : "Untested";
  // Metered lifetime (banked in the pool row, survives restarts) plus the live
  // session counters. The row is banked on nearly every pool-touching write,
  // so the session figure is almost entirely contained in the metered one —
  // max() avoids double-counting while keeping pre-restart history.
  const metered = (pool.bytesSentTotal ?? 0) + (pool.bytesReceivedTotal ?? 0);
  const session = (liveBytes?.bytesSent ?? 0) + (liveBytes?.bytesReceived ?? 0);
  return {
    display,
    poolLabel,
    isEnabled,
    checkTone,
    checkTooltip,
    statusText,
    latency,
    inflight,
    load,
    cooldowns,
    blocked,
    cooldownOnly,
    cooldownText,
    ...(probe === undefined ? {} : { probe }),
    metered,
    session,
    used: Math.max(metered, session),
    proxyFailureLabel,
  };
}

/** Pool name plus status badges; shared by the table cell and the mobile card. */
function PoolTitleBlock({
  pool,
  view,
  maskValues,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly maskValues: boolean;
}): ReactNode {
  return (
    <>
      <span
        className="block text-caption font-semibold overflow-hidden truncate whitespace-nowrap"
        title={maskValues ? MYSTERIOUS_PROXY : view.poolLabel}
      >
        {maskValues ? MYSTERIOUS_PROXY : view.poolLabel}
      </span>
      <div className="flex items-center gap-3 mt-1.5 min-w-0 flex-wrap">
        {pool.status === "disabled" ? (
          <Badge tone="disabled" title={pool.lastError}>
            Disabled{view.proxyFailureLabel ? ` · ${view.proxyFailureLabel}` : ""}
          </Badge>
        ) : (
          <Badge tone={view.checkTone} title={view.checkTooltip}>
            {view.latency === undefined ? view.statusText : `${view.statusText} · ${view.latency}ms`}
          </Badge>
        )}
        {view.blocked.length > 0 ? (
          <Badge tone="disabled" title={view.cooldownText}>
            {view.blocked.length} blocked
          </Badge>
        ) : null}
        {view.probe ? (
          <Badge
            tone={
              view.probe.status === "blocked"
                ? "disabled"
                : view.probe.status === "allowed"
                  ? "ok"
                  : "warn"
            }
            title={
              view.probe.reason ??
              (view.probe.status === "allowed"
                ? view.probe.httpStatus !== undefined && view.probe.httpStatus >= 400
                  // A 4xx here is the upstream rejecting the *probe body*, not
                  // the egress: its IP gate runs first. Saying "served" would
                  // overclaim, so the badge reports what actually happened.
                  ? `Reachable — upstream answered ${view.probe.httpStatus} for the probe body`
                  : "OpenCode served a probe through this pool"
                : view.probe.status === "throttled"
                  ? "OpenCode accepted this egress; the rate is spent"
                  : "The probe could not complete")
            }
          >
            {/* `unreachable` is reserved for a probe that could not complete.
                A 4xx from the upstream's own validation means the egress was
                accepted, so it is never shown as unreachable. */}
            {view.probe.status === "blocked"
              ? "OpenCode blocked"
              : view.probe.status === "allowed"
                ? view.probe.httpStatus !== undefined && view.probe.httpStatus >= 400
                  ? "OpenCode reachable"
                  : "OpenCode OK"
                : view.probe.status === "throttled"
                  ? "OpenCode rate-limited"
                  : "OpenCode unreachable"}
          </Badge>
        ) : null}
        {view.cooldownOnly.length > 0 ? (
          <Badge tone="warn" title={view.cooldownText}>
            {view.cooldownOnly.length} cooldown{view.cooldownOnly.length > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>
    </>
  );
}

/** Egress address plus the last speed-test badge; shared by table and card. */
function PoolAddressBlock({
  pool,
  view,
  speedResult,
  isSpeedTesting,
  maskIp,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly speedResult?: StoredSpeedResult;
  readonly isSpeedTesting: boolean;
  readonly maskIp: boolean;
}): ReactNode {
  return (
    <>
      {pool.egressIp ? (
        <span
          className="font-mono tabular-nums block overflow-hidden text-ellipsis whitespace-nowrap text-badge"
          title={maskIp ? "IP masked" : `egress ${pool.egressIp} · ${view.display.endpoint}`}
        >
          {maskIp ? "IP masked" : pool.egressIp}
        </span>
      ) : (
        <span className="text-badge text-text-tertiary" title="Test the pool to read its egress address">
          not probed
        </span>
      )}
      {(isSpeedTesting || speedResult) && (
        <div className="mt-1.5">
          <Badge
            tone={isSpeedTesting ? "default" : speedResult?.status === "ok" ? "ok" : "err"}
            title={
              isSpeedTesting
                ? "Measuring download throughput"
                : speedResult?.status === "ok"
                  ? `${formatBytes(speedResult.bytes)} in ${speedResult.durationMs}ms${
                      speedResult.measuredAt
                        ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                        : ""
                    }`
                  : `${speedResult?.errorMessage ?? "Speed test failed"}${
                      speedResult?.measuredAt
                        ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                        : ""
                    }`
            }
          >
            {isSpeedTesting
              ? "Speed…"
              : speedResult?.status === "ok"
                ? `${(speedResult.megabitsPerSecond ?? 0).toFixed(1)} Mbps`
                : "Speed failed"}
          </Badge>
        </div>
      )}
    </>
  );
}

/** Load bar plus metered quota bar; shared by the table cell and the mobile card. */
function PoolUsageBars({
  pool,
  view,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
}): ReactNode {
  const quota = pool.quotaBytes;
  const ratio = quota && quota > 0 ? Math.min(1, view.used / quota) : 0;
  const over = quota !== undefined && quota > 0 && view.used > quota;
  return (
    <>
      <div
        title={`${view.inflight}/${pool.maxInflight} inflight`}
        className="flex items-center gap-3"
      >
        <div
          className="flex-1 h-3 rounded-micro overflow-hidden"
        >
          <div
            className="h-full rounded-micro"
            style={{
              width: `${Math.round(view.load * 100)}%`,
              background: view.load >= 0.8 ? "var(--orange)" : "var(--green)",
            }}
          />
        </div>
        <span className="font-mono tabular-nums text-micro text-text-secondary whitespace-nowrap">
          {view.inflight}/{pool.maxInflight}
        </span>
      </div>
      <div
        title={
          quota
            ? `${formatBytes(view.used)} of ${formatBytes(quota)} used · ${formatBytes(view.metered)} metered lifetime`
            : `${formatBytes(view.used)} carried (no quota set) · ${formatBytes(view.session)} this session`
        }
        className="flex items-center gap-3 mt-2"
      >
        <div
          className="flex-1 h-3 rounded-micro overflow-hidden"
        >
          <div
            className="h-full rounded-micro"
            style={{
              width: `${Math.round(ratio * 100)}%`,
              background: over ? "var(--red)" : ratio >= 0.8 ? "var(--orange)" : "var(--teal)",
            }}
          />
        </div>
        <span
          className={`font-mono tabular-nums whitespace-nowrap text-micro ${over ? "text-red" : "text-text-secondary"}`}
        >
          {formatBytes(view.used)}
          {quota ? ` / ${formatBytes(quota)}` : ""}
        </span>
      </div>
    </>
  );
}

/** Row/card actions: test, activity, recover, edit, delete, and the enable switch. */
function PoolActionButtons({
  pool,
  view,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (pool: NetworkPoolResponse) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const clearCooldown = useClearNetworkPoolCooldown();
  const recoverPool = useRecoverNetworkPool();
  return (
    <>
      {view.cooldowns.length > 0 && (
        <Button
          size="icon"
          variant="secondary"
          disabled={clearCooldown.isPending}
          icon={
            clearCooldown.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCcw size={12} />
            )
          }
          onClick={() => clearCooldown.mutate({ poolId: pool.id })}
          title={`Clear provider cooldowns — ${view.cooldownText}`}
          label="Clear"
        />
      )}
      <Button
        size="icon"
        variant="secondary"
        icon={<Activity size={12} />}
        onClick={() => onActivity(pool)}
        title="Health and error activity"
        label="Activity"
      />
      {(pool.status === "cooldown") && (
        <Button
          size="icon"
          variant="secondary"
          disabled={recoverPool.isPending}
          icon={<RotateCcw size={12} className={recoverPool.isPending ? "animate-spin" : ""} />}
          onClick={() => recoverPool.mutate(pool.id)}
          title="Recover pool"
        >
          Recover
        </Button>
      )}
      {!(!view.isEnabled && view.cooldowns.length > 0) && (
        <Button
          size="icon"
          variant="secondary"
          disabled={isTesting}
          icon={
            isTesting ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />
          }
          onClick={() => onHealthCheck(pool)}
          title={view.checkTooltip ?? "Run health check"}
          label="Test"
        />
      )}
      <Button
        size="icon"
        variant="secondary"
        icon={<Pencil size={12} />}
        onClick={() => onEdit(pool)}
        title="Edit pool"
        label="Edit"
      />
      <Button
        size="icon"
        variant="secondary"
        icon={<Trash2 size={12} />}
        onClick={() => onDelete(pool.id)}
        title="Delete pool"
        label="Delete"
      />
      <Switch
        // Pushed to the far right so the on/off control sits apart from
        // the destructive Delete button beside it.
        className="ml-3"
        checked={view.isEnabled}
        disabled={updatePool.isPending}
        onChange={(next) =>
          updatePool.mutate({
            poolId: pool.id,
            request: { status: next ? "active" : "disabled" },
          })
        }
      />
    </>
  );
}

/**
 * One proxy row.
 *
 * Memoized: the list re-renders on selection, testing, and sorting, and each
 * row carries three mutations of its own. Without this every row re-ran those
 * hooks for a change that touched one of them.
 */
const PoolRow = memo(function PoolRow({
  pool,
  isSelected,
  onToggleSelect,
  checkResult,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
  speedResult,
  isSpeedTesting,
  maskValues,
  maskIp,
  probe,
}: {
  readonly pool: NetworkPoolResponse;
  readonly isSelected: boolean;
  readonly onToggleSelect: (id: string) => void;
  readonly checkResult?: HealthCheckResult;
  readonly probe?: PoolProviderProbeResult;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (pool: NetworkPoolResponse) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
  readonly speedResult?: StoredSpeedResult;
  readonly isSpeedTesting: boolean;
  readonly maskValues: boolean;
  readonly maskIp: boolean;
}): ReactNode {
  // Read live usage here rather than as a prop: the parent would otherwise have
  // to hand every row a fresh value on each stream tick, which is exactly the
  // re-render this memo exists to avoid. Only rows whose own pool changed
  // actually re-render.
  const live = useContext(PoolUsageContext);
  const usage = live.live ? live.byId.get(pool.id) : undefined;
  const view = derivePoolView(pool, checkResult, isTesting, usage ?? null, probe);
  return (
    <tr className={view.isEnabled ? "" : "opacity-60"}>
      <td className="w-13">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(pool.id)}
          aria-label={`Select ${view.poolLabel}`}
        />
      </td>
      <td className="min-w-0 max-w-150">
        <PoolTitleBlock pool={pool} view={view} maskValues={maskValues} />
      </td>
      <td className="min-w-0 max-w-90">
        {pool.family ? (
          <span
            className="truncate text-caption font-semibold text-text-secondary"
            title={pool.family}
          >
            {pool.family}
          </span>
        ) : (
          <span className="text-badge text-text-tertiary">—</span>
        )}
      </td>
      <td className="max-w-110">
        <PoolAddressBlock
          pool={pool}
          view={view}
          speedResult={speedResult}
          isSpeedTesting={isSpeedTesting}
          maskIp={maskIp}
        />
      </td>
      <td className="min-w-55">
        <PoolUsageBars pool={pool} view={view} />
      </td>
      <td className="whitespace-nowrap pl-36 text-right">
        <Inline gap="4px" justify="end">
          <PoolActionButtons
            pool={pool}
            view={view}
            isTesting={isTesting}
            onDelete={onDelete}
            onEdit={onEdit}
            onHealthCheck={onHealthCheck}
            onActivity={onActivity}
          />
        </Inline>
      </td>
    </tr>
  );
});


function PoolHealthDialog({
  pool,
  onClose,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
}): ReactNode {
  const query = useNetworkPoolHealthEvents(pool.id);
  const recover = useRecoverNetworkPool();
  const events = query.data ?? [];

  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const disabledForProxyResponse = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const statusTone: BadgeTone =
    pool.status === "active" ? "ok" : pool.status === "disabled" ? "disabled" : "warn";
  return (
    <Dialog open onClose={onClose} title={`Health & Activity — ${poolName(pool)}`}>
      <Stack gap="14px">
        {/* A proxy rejected for payment/auth is a different situation from a
            plain disable, so its frame says so rather than leaving it to the badge. */}
        <div
          className={`flex items-center gap-8 rounded-panel border bg-surface-2 p-8 ${disabledForProxyResponse ? "border-orange" : "border-inner-border"}`}
        >
          <div className="min-w-0 flex-1">
            <div
              className="mb-2.5 text-text-tertiary text-micro font-bold tracking-label uppercase"
            >
              Proxy health
            </div>
            <div className="text-title font-bold leading-[1.3]">
              {disabledForProxyResponse ? "Proxy reachable" : `Proxy ${pool.status}`}
            </div>
            <p
              className="mt-3 mx-0 mb-0 text-text-secondary text-caption leading-normal wrap-anywhere"
            >
              {disabledForProxyResponse
                ? `${proxyFailureLabel} · disabled from routing`
                : pool.lastError ?? "No recent proxy errors."}
            </p>
          </div>
          <Badge tone={statusTone} dot>
            {pool.status}
          </Badge>
        </div>
        {(pool.status === "cooldown") && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={recover.isPending}
              onClick={() => recover.mutate(pool.id)}
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
            >
              Recover Now
            </Button>
          </div>
        )}
        {/* `compact`: this panel sits inside a scroll region, so the state must
            not reserve the route-level centering floor. */}
        {query.isPending ? <LoadingState compact label="Loading pool activity…" /> : null}
        {query.isError ? <ErrorState compact message="Failed to load pool activity" onRetry={() => void query.refetch()} /> : null}
        {!query.isPending && !query.isError && events.length === 0 ? (
          <EmptyState compact title="No pool activity" message="Proxy checks, disable events, and recoveries will appear here." />
        ) : null}
        {events.length > 0 ? (
          <div
            className="grid gap-4 max-h-190 overflow-y-auto pr-1"
          >
            {events.map((event) => (
              <div
                key={event.id}
                className="p-6 border border-inner-border rounded-control bg-surface-1"
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-4"
                >
                  <Inline gap="6px">
                    <Badge
                      tone={
                        event.toStatus === "active"
                          ? "ok"
                          : event.toStatus === "disabled"
                            ? "disabled"
                            : "warn"
                      }
                    >
                      {event.fromStatus ?? "new"} → {event.toStatus}
                    </Badge>
                    {event.errorCategory ? (
                      <Badge tone={event.errorCategory.startsWith("proxy_") ? "warn" : "err"}>
                        {event.errorCategory}
                      </Badge>
                    ) : null}
                  </Inline>
                  <time
                    className="text-text-tertiary text-badge tabular-nums"
                  >
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </div>
                <p
                  className="mt-4 mx-0 mb-0 text-text-secondary text-caption leading-normal wrap-anywhere"
                >
                  {event.reason ?? "No additional details"}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Stack>
    </Dialog>
  );
}

export default function Proxy(): ReactNode {
  const poolsQuery = useNetworkPools();
  const deletePool = useDeleteNetworkPool();
  const updatePool = useUpdateNetworkPool();
  const healthCheck = useHealthCheckNetworkPool();
  const [showProxyForm, setShowProxyForm] = useState(false);
  const closeAddProxy = useCallback(() => setShowProxyForm(false), []);
  const [addProxyActions, setAddProxyActions] = useState<ReactNode>(null);
  const [editProxyActions, setEditProxyActions] = useState<ReactNode>(null);
  const [showRelayDeploy, setShowRelayDeploy] = useState(false);
  const [editingPool, setEditingPool] = useState<NetworkPoolResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const privacy = usePrivacyMode();
  const maskValues = privacy.enabled;
  const ipMask = useMaskIp();
  const maskIp = ipMask.enabled;
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set());
  // The split control's payload choice, persisted like the other view
  // preferences: an operator debugging OpenCode wants that payload on return.
  const [testPayload, setTestPayload] = useState<TestPayload>(() => {
    try {
      return localStorage.getItem(TEST_PAYLOAD_STORAGE_KEY) === "opencode" ? "opencode" : "url";
    } catch {
      return "url";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TEST_PAYLOAD_STORAGE_KEY, testPayload);
    } catch {
      // A blocked storage must not break the page.
    }
  }, [testPayload]);
  const [providerTestingIds, setProviderTestingIds] = useState<ReadonlySet<string>>(new Set());
  /**
   * Verdicts measured in this tab, before the refetched row carries them.
   *
   * The stored verdict lives on the pool row (`providerProbe`) — that is the
   * one every reader shares. This map only bridges the moment between a probe
   * finishing and the query refetch landing, and it seeds the add form's
   * verdict onto a row created in the same session. It is deliberately not
   * persisted: `localStorage` made the verdict visible to one browser and to
   * nobody else, so a pool could read "OpenCode blocked" here while dispatch
   * kept routing through it.
   */
  const [providerResults, setProviderResults] = useState<Record<string, StoredProviderResult>>({});
  const providerProbe = useProviderProbeNetworkPool();
  const speedTest = useSpeedTestNetworkPool();
  const [speedBytes, setSpeedBytes] = useState(SPEED_TEST_DEFAULT_BYTES);
  // Persisted like `checkResults`: a measurement is expensive to take (it pulls
  // real bytes through the operator's proxy plan) and is still the last known
  // throughput after a reload, so throwing it away on navigation is wasteful.
  const [speedResults, setSpeedResults] = useState<Record<string, StoredSpeedResult>>(() => {
    try {
      const saved = localStorage.getItem("cartethyia_proxy_speed_results");
      return saved ? (JSON.parse(saved) as Record<string, StoredSpeedResult>) : {};
    } catch {
      return {};
    }
  });
  const [speedTestingIds, setSpeedTestingIds] = useState<ReadonlySet<string>>(new Set());
  const rememberSpeedResult = useCallback((poolId: string, result: StoredSpeedResult) => {
    const stamped = { ...result, measuredAt: new Date().toISOString() };
    setSpeedResults((prev) => {
      const next = { ...prev, [poolId]: stamped };
      try {
        localStorage.setItem("cartethyia_proxy_speed_results", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const [checkResults, setCheckResults] = useState<Record<string, HealthCheckResult>>(() => {
    // Seeded from the server row (`lastSuccessAt`/`lastErrorAt`) by
    // `derivePoolView`, so this map only carries what the browser measured
    // since the page opened. A bulk import that tests and then saves reports
    // both verdicts here, and losing them on reload would put the rows back to
    // "Untested" for a check the operator already paid for.
    try {
      const saved = localStorage.getItem(CHECK_RESULTS_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as Record<string, HealthCheckResult>) : {};
    } catch {
      return {};
    }
  });
  const [sort, setSort] = useState<{ key: PoolSortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  });
  const [deleteTargets, setDeleteTargets] = useState<NetworkPoolResponse[] | null>(null);
  const [activityPool, setActivityPool] = useState<NetworkPoolResponse | null>(null);
  const pools = poolsQuery.data ?? [];
  const sortedPools = useMemo(
    () => sortPools(pools, sort.key, sort.direction, (pool) => poolLatencyMs(pool, checkResults[pool.id])),
    [pools, sort, checkResults],
  );
  const toggleSort = useCallback((key: string) => {
    const next = key as PoolSortKey;
    setSort((prev) =>
      prev.key === next
        ? { key: next, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key: next, direction: "asc" },
    );
  }, []);
  const isPending = poolsQuery.isPending;
  const isError = poolsQuery.isError;

  const allSelected = pools.length > 0 && pools.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(pools.map((p) => p.id)));
  };
  // Stable identities: the memoized rows only skip a re-render when the props
  // they receive keep the same reference across the parent's renders.
  const toggleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CHECK_RESULTS_STORAGE_KEY, JSON.stringify(checkResults));
    } catch {
      // A blocked storage must not break the page.
    }
  }, [checkResults]);

  const results = Object.values(checkResults);
  const testedCount = results.length;
  const successCount = results.filter((r) => r.status === "healthy" || r.status === "reachable").length;
  const errorCount = results.filter((r) => r.status !== "healthy" && r.status !== "reachable").length;

  const runCheck = useCallback((pool: NetworkPoolResponse) => {
    setTestingIds((prev) => new Set(prev).add(pool.id));
    healthCheck.mutate(pool.id, {
      onSuccess: (result) => {
        setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        const label = poolName(pool);
        if (result.status === "healthy") {
          toast.success(`${label}: connected`, `${result.latencyMs ?? 0}ms`);
        } else if (result.status === "reachable") {
          toast.error(`${label}: proxy reachable · disabled`, result.errorMessage);
        } else {
          toast.error(
            `${label}: ${result.status === "timeout" ? "timeout" : "unhealthy"}`,
            result.errorMessage,
          );
        }
      },
      onError: (err) => {
        const label = poolName(pool);
        toast.error(`${label}: check failed`, getErrorMessage(err, "Health check failed"));
      },
      onSettled: () => {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(pool.id);
          return next;
        });
      },
    });
  }, [healthCheck]);

  // Eight at a time: a health check is a small probe, so a wider batch finishes
  // the list without flooding the endpoints the way an unbounded fan-out would.
  const runAllChecks = async () => {
    const targets = pools;
    if (targets.length === 0) return;
    let healthy = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await healthCheck.mutateAsync(pool.id);
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
          if (result.status === "healthy") healthy += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const result: HealthCheckResult = {
            poolId: pool.id,
            status: "timeout",
            errorMessage: getErrorMessage(err, "Health check failed"),
          };
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        } finally {
          setTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
    toast.success(`Tested ${targets.length} pools · ${healthy} healthy · ${failed} failed`);
  };

  /**
   * The same bounded health check as `runAllChecks`, restricted to the current
   * selection. The selected row is the operator's "test this one first" intent;
   * without it the only way to test a subset was to select everything else and
   * use Test all.
   */
  const runTestSelected = async () => {
    const targets = pools.filter((pool) => selectedIds.has(pool.id));
    if (targets.length === 0) return;
    let healthy = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await healthCheck.mutateAsync(pool.id);
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
          if (result.status === "healthy") healthy += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const result: HealthCheckResult = {
            poolId: pool.id,
            status: "timeout",
            errorMessage: getErrorMessage(err, "Health check failed"),
          };
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        } finally {
          setTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
    toast.success(`Tested ${targets.length} pools · ${healthy} healthy · ${failed} failed`);
  };

  /**
   * Asks OpenCode, through each selected pool, whether it will serve us.
   *
   * Bounded like the health check but narrower: each probe opens a tunnel and
   * a TLS session to the provider, so four at a time finishes a selection
   * without the fan-out reading as an outage upstream.
   *
   * Read-only. The probe reports what it saw and leaves the pool in rotation;
   * a real dispatch that is refused is what retires the egress. An operator
   * testing a proxy wants to know its state, not to change it — and a probe
   * that mutated would make "test" unsafe to press.
   */
  const runProviderProbeSelected = async () => {
    const targets = pools.filter((pool) => selectedIds.has(pool.id));
    if (targets.length === 0) return;
    let allowed = 0;
    let blocked = 0;
    let throttled = 0;
    let unreachable = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setProviderTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await providerProbe.mutateAsync({
            poolId: pool.id,
            providerId: PROBE_PROVIDER_ID,
          });
          setProviderResults((prev) => ({
            ...prev,
            [pool.id]: { endpoint: pool.endpoint ?? "", result },
          }));
          if (result.status === "allowed") allowed += 1;
          else if (result.status === "blocked") blocked += 1;
          else if (result.status === "throttled") throttled += 1;
          else unreachable += 1;
        } catch (err) {
          unreachable += 1;
          setProviderResults((prev) => ({
            ...prev,
            [pool.id]: {
              endpoint: pool.endpoint ?? "",
              result: {
                poolId: pool.id,
                providerId: PROBE_PROVIDER_ID,
                status: "unreachable",
                reason: getErrorMessage(err, "Provider probe failed"),
              },
            },
          }));
        } finally {
          setProviderTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROVIDER_PROBE_CONCURRENCY, targets.length) }, () => worker()),
    );
    toast.success(
      `OpenCode: ${allowed} allowed · ${blocked} blocked` +
        (throttled > 0 ? ` · ${throttled} rate-limited` : "") +
        (unreachable > 0 ? ` · ${unreachable} unreachable` : ""),
    );
  };

  // One at a time. Each test pulls several megabytes, and two running together
  // share the operator's uplink, so neither number is the pool's real speed.
  const runSpeedTestSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setSpeedTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await speedTest.mutateAsync({ poolId: pool.id, bytes: speedBytes });
          rememberSpeedResult(pool.id, result);
        } catch (err) {
          rememberSpeedResult(pool.id, {
            poolId: pool.id,
            status: "failed",
            bytes: 0,
            durationMs: 0,
            errorMessage: getErrorMessage(err, "Speed test failed"),
          });
        } finally {
          setSpeedTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await worker();
    toast.success(`Speed tested ${targets.length} pool(s)`);
  };

  const enableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map((p) => updatePool.mutateAsync({ poolId: p.id, request: { status: "active" } })),
    );
    setSelectedIds(new Set());
    toast.success(`Enabled ${targets.length} pool(s)`);
  };

  const disableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map((p) => updatePool.mutateAsync({ poolId: p.id, request: { status: "disabled" } })),
    );
    setSelectedIds(new Set());
    toast.success(`Disabled ${targets.length} pool(s)`);
  };

  const exportSelected = () => {
    const targets = selectedIds.size > 0 ? pools.filter((p) => selectedIds.has(p.id)) : pools;
    if (targets.length === 0) return;
    const content = targets.map((p) => poolDisplay(p).endpoint || p.endpoint).join("\n");
    downloadTextFile("cartethyia-proxies.txt", content, "text/plain;charset=utf-8");
    toast.success(`Exported ${targets.length} pool(s)`);
  };

  const requestDeletePool = useCallback(
    (id: string) => {
      const pool = pools.find((p) => p.id === id);
      if (pool) setDeleteTargets([pool]);
    },
    [pools],
  );

  const requestDeleteSelected = () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    setDeleteTargets(targets);
  };

  const confirmDelete = async () => {
    if (!deleteTargets) return;
    await Promise.all(deleteTargets.map((p) => deletePool.mutateAsync(p.id)));
    setSelectedIds(new Set());
    toast.success(`Deleted ${deleteTargets.length} pool(s)`);
    setDeleteTargets(null);
  };

  return (
    <ProxyLiveProvider>
      <Stack gap="16px">
      <Dialog
        open={showProxyForm}
        onClose={closeAddProxy}
        title="Add Proxy"
        footer={addProxyActions}
      >
        <ProxyBulkForm
          onClose={closeAddProxy}
          actionsRef={setAddProxyActions}
          onProbeResult={(poolId, result) => {
            // The row may not exist in this list yet (the add form reports
            // before the refetch lands), so the endpoint is read from the
            // payload the probe itself carried rather than from `pools`.
            const created = pools.find((entry) => entry.id === poolId);
            setProviderResults((prev) => ({
              ...prev,
              [poolId]: { endpoint: created?.endpoint ?? "", result },
            }));
          }}
          onHealthResult={(poolId, result) => {
            setCheckResults((prev) => ({ ...prev, [poolId]: result }));
          }}
        />
      </Dialog>

      <Dialog
        open={editingPool !== null}
        onClose={() => setEditingPool(null)}
        title="Edit pool"
        footer={editProxyActions}
      >
        {editingPool && (
          <PoolEditForm
            key={editingPool.id}
            pool={editingPool}
            onClose={() => setEditingPool(null)}
            actionsRef={setEditProxyActions}
          />
        )}
      </Dialog>

      <Card
        style={pools.length === 0 && !isPending && !isError ? { minHeight: "min(78dvh, calc(100dvh - 160px))", display: "flex", flexDirection: "column" } : undefined}
      >
        <CardHeader
          title="Proxy Pool"
          subtitle="Outbound proxy servers — HTTP, HTTPS, and SOCKS5"
          icon={<ShieldCheck size={16} />}
          action={
            <Inline gap="8px">
              <Button
                variant="secondary"
                size="sm"
                icon={<Cloud size={13} />}
                onClick={() => setShowRelayDeploy(true)}
              >
                Deploy relay
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setShowProxyForm(true)}
              >
                Add proxies
              </Button>
            </Inline>
          }
        />
        <CardBody
          style={pools.length === 0 && !isPending && !isError ? { flex: 1, display: "flex", flexDirection: "column", gap: "16px" } : undefined}
        >
          <ProxySummaryTiles pools={pools} />

          {/* Selection & Batch Toolbar (Image 2 style) */}
          {pools.length > 0 && (
            <div className="nested-panel flex flex-wrap items-center justify-start overflow-x-auto rounded-card border border-inner-border bg-surface-2 p-4 text-badge">
              <div className="flex flex-wrap items-center gap-5">
                <label
                  className="flex items-center gap-3 cursor-pointer text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all proxies"
                  />
                  Select all
                  {selectedIds.size > 0 && (
                    <span className="text-text-tertiary">({selectedIds.size})</span>
                  )}
                </label>
                {testedCount > 0 && (
                  <Inline gap="6px">
                    <span className="text-text-tertiary">
                      Tested {testedCount}/{pools.length}
                    </span>
                    {successCount > 0 && <Badge tone="ok">{successCount} success</Badge>}
                    {errorCount > 0 && <Badge tone="err">{errorCount} errors</Badge>}
                  </Inline>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={maskValues ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => privacy.setEnabled(!maskValues)}
                  title={maskValues ? "Show proxy names and addresses" : "Hide proxy names and addresses"}
                >
                  {maskValues ? "Unmask" : "Mask"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={maskIp ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => ipMask.setEnabled(!maskIp)}
                  title={maskIp ? "Show egress addresses" : "Hide egress addresses"}
                >
                  {maskIp ? "Show IP" : "Mask IP"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={testingIds.size > 0 || pools.length === 0}
                  icon={
                    testingIds.size > 0 ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <FlaskConical size={12} />
                    )
                  }
                  onClick={() => void runAllChecks()}
                >
                  Test all
                </Button>
                {/* Split control: the primary half runs the payload the
                    dropdown selects against the current selection. Test all
                    stays outside this control because it deliberately ignores
                    the selection. */}
                <div className="inline-flex items-stretch h-15">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-tr-none rounded-br-none"
                    disabled={
                      testingIds.size > 0 ||
                      providerTestingIds.size > 0 ||
                      selectedIds.size === 0
                    }
                    icon={
                      testingIds.size > 0 || providerTestingIds.size > 0 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <FlaskConical size={12} />
                      )
                    }
                    onClick={() =>
                      void (testPayload === "opencode"
                        ? runProviderProbeSelected()
                        : runTestSelected())
                    }
                  >
                    {testPayload === "opencode" ? "Test OpenCode" : "Test URL"}
                  </Button>
                  <Select
                    aria-label="Test payload"
                    value={testPayload}
                    onValueChange={(value) => setTestPayload(value as TestPayload)}
                    options={TEST_PAYLOAD_OPTIONS}
                    disabled={testingIds.size > 0 || providerTestingIds.size > 0}
                    className="w-auto min-w-38 h-15 rounded-tl-none rounded-bl-none -ml-0.5"
                  />
                </div>
                {/* Split control: the primary half runs the test at the
                    currently-selected payload, the chevron half picks the
                    payload. Kept as two elements in one bordered shell so it
                    reads as a single control without a bespoke component. */}
                <div
                  className="inline-flex items-stretch h-15"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-tr-none rounded-br-none"
                    disabled={
                      selectedIds.size === 0 || speedTestingIds.size > 0 || speedTest.isPending
                    }
                    icon={
                      speedTestingIds.size > 0 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Gauge size={12} />
                      )
                    }
                    onClick={() => void runSpeedTestSelected()}
                  >
                    Speedtest selected
                  </Button>
                  <Select
                    aria-label="Speed test payload size"
                    value={String(speedBytes)}
                    onValueChange={(value) => setSpeedBytes(Number(value))}
                    options={SPEED_TEST_SIZES}
                    disabled={speedTestingIds.size > 0 || speedTest.isPending}
                    className="w-auto min-w-38 h-15 rounded-tl-none rounded-bl-none -ml-0.5"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pools.length === 0}
                  icon={<Download size={12} />}
                  onClick={exportSelected}
                >
                  Export
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<Power size={12} />}
                  onClick={() => void enableSelected()}
                >
                  Enable selected
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<PowerOff size={12} />}
                  onClick={() => void disableSelected()}
                >
                  Disable selected
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={selectedIds.size === 0 || deletePool.isPending}
                  icon={<Trash2 size={12} />}
                  onClick={requestDeleteSelected}
                >
                  Delete selected
                </Button>
              </div>
            </div>
          )}

          {isPending && <LoadingState />}
          {isError && <ErrorState title="Error" message="Failed to load network pools" />}
          {!isPending && !isError && pools.length === 0 && (
            <div className="flex-1 flex items-center justify-center p-12 border border-dashed border-transparent rounded-card bg-transparent text-center">
              <EmptyState
                title="No proxy pools configured"
                message="The summary above is empty because nothing is routing yet. Use Add proxies or Deploy relay in the header to start one."
              />
            </div>
          )}
          {!isPending && !isError && pools.length > 0 && (
            <div className="proxy-table-scroll rounded-control border border-inner-border bg-surface-1">
              <DataTable
                maxHeight={460}
                scrollRegion
                headers={[
                  "",
                  { key: "name", label: "Proxy", sortable: true },
                  { key: "family", label: "Family", sortable: true },
                  { key: "address", label: "Address", sortable: true },
                  { key: "load", label: "Load", sortable: true },
                  "Actions",
                ]}
                sortKey={sort.key}
                sortDirection={sort.direction}
                onSort={toggleSort}
              >
                {sortedPools.map((pool) => (
                  <PoolRow
                    key={pool.id}
                    pool={pool}
                    isSelected={selectedIds.has(pool.id)}
                    onToggleSelect={toggleSelectOne}
                    checkResult={checkResults[pool.id]}
                    probe={
                      // The row's own verdict wins: it is the one every reader
                      // shares and the one a reload keeps. The local map only
                      // covers the gap before the refetch lands.
                      pool.providerProbe !== undefined
                        ? {
                            poolId: pool.id,
                            providerId: pool.providerProbe.providerId,
                            status: pool.providerProbe.status,
                            ...(pool.providerProbe.httpStatus === undefined
                              ? {}
                              : { httpStatus: pool.providerProbe.httpStatus }),
                            ...(pool.providerProbe.reason === undefined
                              ? {}
                              : { reason: pool.providerProbe.reason }),
                            ...(pool.providerProbe.latencyMs === undefined
                              ? {}
                              : { latencyMs: pool.providerProbe.latencyMs }),
                          }
                        : liveProbeFor(providerResults[pool.id], pool.endpoint)
                    }
                    isTesting={testingIds.has(pool.id)}
                    onDelete={requestDeletePool}
                    onEdit={setEditingPool}
                    onHealthCheck={runCheck}
                    onActivity={setActivityPool}
                    speedResult={newerSpeedResult(speedResults[pool.id], serverSpeedResult(pool))}
                    isSpeedTesting={speedTestingIds.has(pool.id)}
                    maskValues={maskValues}
                    maskIp={maskIp}
                  />
                ))}
              </DataTable>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={deleteTargets !== null}
        onClose={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
        title="Delete proxy pool?"
        message={
          deleteTargets && deleteTargets.length === 1
            ? `Delete "${poolName(deleteTargets[0]!)}"? This cannot be undone.`
            : deleteTargets
              ? `Delete ${deleteTargets.length} proxy pools? This cannot be undone.`
              : "Delete this proxy pool? This cannot be undone."
        }
        confirmLabel="Delete"
        danger
      />
      {activityPool ? (
        <PoolHealthDialog pool={activityPool} onClose={() => setActivityPool(null)} />
      ) : null}
      {showRelayDeploy ? <RelayDeployModal onClose={() => setShowRelayDeploy(false)} /> : null}
      </Stack>
    </ProxyLiveProvider>
  );
}
