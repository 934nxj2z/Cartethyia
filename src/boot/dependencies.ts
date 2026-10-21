
import { assertPoolFitsServerCapacity, bootDatabase, ensureMigrated } from "../persistence/boot";
import { poolMaxFromEnv } from "../persistence/db-pg";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { resolveRedisBackend, resolveRedisClient } from "../persistence/redis";
import type { RedisClient } from "../persistence/redis";
import {
  bundledModelCatalog,
  liveProviderUpstreamHosts,
  markCatalogSeeded,
  refreshActiveProviderCatalogs,
  registerByokProviders,
  retireUnbundledProviders,
  seedBundledProviders,
} from "../providers/operations/provider-catalog-service";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import { createDefaultProviderRegistry } from "../providers/default-registry";
import { OAuthRefreshService, loadDueOAuthAccounts, reconcileStaticTokenAccounts } from "../providers/authentication/oauth-refresh-service";
import type { OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { oauthRefreshSweep } from "../workers/oauth-refresh-sweep";
import { accountIdentitySweep } from "../workers/account-identity-sweep";
import { pushStructuredConsoleLog } from "../observability/log-ring";
import { seedBundledModels } from "../providers/operations/provider-catalog-seeder";
import { createDatabaseSnapshotBuilder } from "../transport/routing/route-catalog";
import { DrizzleProviderCatalogStore } from "../console/providers/catalog/store";
import { InMemoryRouteSnapshotService } from "../transport/routing/route-model";
import { RoutingEngine } from "../transport/routing/router";
import { RedisAdmissionController } from "../transport/routing/admission";
import { ApiKeyAdmissionService } from "../security/admission/service";
import { InMemoryAdmissionCounterStore } from "../security/admission/in-memory-store";
import { RedisAdmissionCounterStore } from "../security/admission/redis-store";
import { sweepLeases } from "../security/admission/lease-sweep";
import { DrizzleApiKeyStore } from "../persistence/stores/api-key-store";
import { UsageFlushBuffer } from "../persistence/usage-flush";
import { setPendingUsageSource } from "../security/api-key-auth";
import { HealthEventFlushBuffer, setHealthEventBuffer } from "../persistence/health-event-flush";
import { subscribePeerSettingsRevisions } from "../persistence/settings-revision";
import { deleteExpiredSessions } from "../console/auth/session-service";
import { InMemoryIpAbuseStore, IpAbuseProtectionService, RedisIpAbuseStore } from "../security/abuse";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  RedisModelAbuseStore,
} from "../security/model-abuse";
import { checkReadiness } from "../persistence/readiness";
import { ProxyRequestPreparer } from "../transport/request/preparer";
import { DrizzleNetworkPoolLoader } from "../network/pool/loader";
import {
  PoolAgentResolver,
  ValidatedNetworkBindingFactory,
} from "../network/pool/resolver";
import { NetworkPoolSelector } from "../network/pool/selector";
import { ScheduledTaskRegistry } from "../workers/scheduler";
import { quotaRefreshSweep } from "../workers/quota-refresh-sweep";
import { dailyCheckinEgressForPass } from "../workers/daily-checkin";
import {
  buddyAdoptTask,
  buddyActivityReportTask,
  buddyLotteryTask,
  buddyRedeemTask,
  buddyStreakTask,
  buddyTravelTask,
  buddyTrialTask,
  syncBuddyUsage,
} from "../workers/buddy-growth-tasks";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { quotaCacheSize } from "../console/quota/cache";
import { modelCatalogCacheSize } from "../providers/operations/model-catalog-cache";
import { preferencesReaderFor } from "../persistence/tenant-preferences";
import { sweepExpiredCooldowns } from "../providers/operations/account-health-service";
import { DrizzleTelemetryStore } from "../persistence/stores/telemetry-store";
import { TelemetryPayloadCapture } from "../observability/payload-capture";
import { sweepExpiredPoolCooldowns } from "../network/pool-health-machine";
import { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import { RuntimeMetricsSampler } from "../observability/runtime-metrics";
import {
  resolveIpRateLimit,
  resolveModelBanTtlMs,
  resolveModelStrikeThreshold,
  resolveModelStrikeWindowMs,
} from "../config/security";
import { resolveSsrfPolicy, resolveTrustedProxyBoundary } from "../config/network";
import type { TrustedProxyBoundary } from "../config/network";
import { resolveTelemetryRetentionDays } from "../config/telemetry";
import { CONFIG_SPEC, readInt, readList } from "../config/spec";
import type { ProviderAdapter } from "../providers/provider-contracts";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { ByokUpstreamHost } from "../providers/operations/provider-catalog-service";
import type { ReadinessCheckResult } from "../persistence/readiness";
import { log } from "../observability/logger";
import { refreshProviderClientVersions } from "../providers/operations/client-versions";


export interface ProductionDeps {
  db: CartethyiaDatabase;
  redis: RedisClient | undefined;
  snapshotService: InMemoryRouteSnapshotService;
  /** Live routing admission snapshot scoped to one provider/tenant for console reads. */
  readRoutingAccountInflight: (
    providerId: string,
    tenantId: string | null,
  ) => Promise<readonly { accountId: string; inflight: number }[]>;
  /** On-demand adapter resolution keeps heavy providers out of the boot path. */
  resolveProviderAdapter: (providerId: string) => Promise<ProviderAdapter | undefined>;
  bundledModelCatalog: BundledProviderCatalog;
  /** Live lookup of a provider's SSRF-validated upstream host. */
  byokUpstreamHosts: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
  proxyPreparer: ProxyRequestPreparer;
  networkBindingFactory: ValidatedNetworkBindingFactory;
  ipAbuseProtection: IpAbuseProtectionService;
  readiness: () => Promise<ReadinessCheckResult>;
  scheduledTasks: ScheduledTaskRegistry;
  poolAgentResolver: PoolAgentResolver;
  poolSelector: NetworkPoolSelector;
  telemetryBuffer: TelemetryBatchBuffer;
  usageFlush: UsageFlushBuffer;
  healthEventFlush: HealthEventFlushBuffer;
  trustedProxyBoundary: TrustedProxyBoundary;
  providerRegistry: ProviderRegistry;
  resolveOAuthRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  oauthRefreshService: OAuthRefreshService;
  admissionService: ApiKeyAdmissionService;
  /** Graduated strikes for repeated invalid-model requests. */
  modelStrikes: ModelStrikeService;
  /** Memory sampler; in-flight source is bound once the request store exists. */
  runtimeMetricsSampler: RuntimeMetricsSampler;
}

/**
 * Pause between accounts in the OAuth refresh sweep. The token endpoints
 * rate-limit a burst of refreshes even at low concurrency.
 */
const OAUTH_REFRESH_INTER_ITEM_DELAY_MS = 1_500;

/**
 * Client identities are refreshed out of band so provider dispatch never waits
 * on npm/provider version endpoints. Resolver TTLs deduplicate the sources.
 */
// Matched to the resolver's own 30 min cache TTL: at 15 min every second pass
// was a pure cache read that could not discover anything new.
const CLIENT_VERSION_MONITOR_INTERVAL_MS = 30 * 60_000;
const CLIENT_VERSION_INITIAL_DELAY_MS = 10_000;

export async function buildProductionDeps(): Promise<ProductionDeps> {
  const startupStartedAt = performance.now();
  const startupMemoryBefore = process.memoryUsage();
  const handle = await measureStartupPhase("database-connect", bootDatabase);
  const db = handle.db;
  // One rule, no mode flag: REDIS_URL set → shared client, unset → memory.
  const redis = resolveRedisClient();
  const ssrfPolicy = resolveSsrfPolicy();
  await measureStartupPhase("database-migrations", async () => {
    await ensureMigrated();
    // Pool sizing is an external-server concern; the embedded backend has no
    // connection budget to fit into.
    if (handle.kind === "pg") await assertPoolFitsServerCapacity(poolMaxFromEnv());
  });
  await measureStartupPhase("provider-seed", () => seedBundledProviders(db));
  // Boot-only: retire global rows for providers the bundle has dropped, so a
  // retired provider cannot linger as a card the console can no longer delete.
  // Kept off the test harness path, which shares one database across suites and
  // installs its own global fixtures.
  await measureStartupPhase("retired-provider-cleanup", () => retireUnbundledProviders(db));
  const registry = createDefaultProviderRegistry();
  // Live view, not a snapshot: custom providers registered after boot (or
  // edited from the console) must resolve their SSRF binding immediately.
  const byokUpstreamHosts = liveProviderUpstreamHosts(registry);
  await measureStartupPhase("byok-registration", () =>
    registerByokProviders(registry, db, ssrfPolicy),
  );
  const bundledCatalog = await measureStartupPhase("bundled-model-catalog", () =>
    bundledModelCatalog(registry),
  );
  await measureStartupPhase("bundled-model-seed", () =>
    seedBundledModels(db, bundledCatalog.modelsByProvider),
  );
  // The boot seed above is unconditional, so record it: the snapshot builder's
  // first rebuild would otherwise re-seed an identical catalog.
  markCatalogSeeded();
  const snapshotService = new InMemoryRouteSnapshotService(
    createDatabaseSnapshotBuilder(db, () => refreshActiveProviderCatalogs(db, registry)),
  );
  const routingEngine = new RoutingEngine(
    redis ? new RedisAdmissionController(redis) : undefined,
    redis,
  );
  const readRoutingAccountInflight = async (
    providerId: string,
    tenantId: string | null,
  ): Promise<readonly { accountId: string; inflight: number }[]> => {
    if (providerId === "" || tenantId === null) return [];
    const snapshot = await routingEngine.accountInflightSnapshot();
    const accounts = await new DrizzleProviderCatalogStore(db, {
      telemetryBuffer,
      bundledModelCatalog: bundledCatalog,
      providerRegistry: registry,
      outboundFetchFor: async () => ({ fetch: networkBindingFactory.fetch(undefined, tenantId) }),
      snapshotInvalidator: snapshotService,
    }).listAccounts(tenantId, providerId);
    const owned = new Set(accounts.map((account) => account.id));
    const totals = new Map<string, number>();
    for (const [bucket, count] of snapshot) {
      const prefix = `${providerId}:`;
      if (!bucket.startsWith(prefix)) continue;
      const accountId = bucket.slice(bucket.lastIndexOf(":") + 1);
      if (!owned.has(accountId)) continue;
      totals.set(accountId, (totals.get(accountId) ?? 0) + count);
    }
    return [...totals].map(([accountId, inflight]) => ({ accountId, inflight }));
  };
  // Peer processes' settings mutations arrive here. Subscribed once for the
  // process: the revision counter is process-global, and the handler only
  // moves it forward.
  subscribePeerSettingsRevisions();
  const usageFlush = new UsageFlushBuffer(db);
  // Auth reads lifetime usage to seed the admission counter. The persisted
  // value lags by up to one flush interval, so hand it the in-flight deltas
  // too — otherwise the seed is systematically under what has actually been
  // spent, worst exactly when the key is busiest.
  setPendingUsageSource((apiKeyId) => usageFlush.pendingFor(apiKeyId));
  // Health audit rows are append-only and read by nobody in dispatch, so they
  // no longer land inside the request. The status write they accompany stays
  // synchronous — routing reads it.
  const healthEventFlush = new HealthEventFlushBuffer(db);
  setHealthEventBuffer(healthEventFlush);
  const admissionStore = redis
    ? new RedisAdmissionCounterStore(redis)
    : new InMemoryAdmissionCounterStore();
  const admissionService = new ApiKeyAdmissionService(
    admissionStore,
    undefined,
    // The per-tenant concurrency cap is a `console_settings` preference, read
    // on every admitted request. Reading it directly cost one Postgres round
    // trip per request (multiplied by each failover candidate); the shared
    // revision-keyed reader answers from memory and converges the moment an
    // operator saves, because `DrizzleRuntimeSettingsStore.update` bumps the
    // revision every cached key embeds.
    (tenantId) =>
      preferencesReaderFor(db)
        .readPreferences(tenantId)
        .then((prefs) => prefs?.tenantConcurrencyLimit ?? null),
    ({ apiKeyId, delta }) => {
      // Coalesced: one UPDATE per key per flush instead of one per request.
      // The admission counter is the live total; this only persists it.
      usageFlush.enqueue(apiKeyId, delta);
      return Promise.resolve();
    },
    // Fresh lifetime reader — invoked by the store only when it is about to
    // seed a missing `admission:lifetime:<id>` counter, so the ≤3s-stale auth
    // snapshot value cannot freeze a low baseline in place. Family total: the
    // row plus every child (share recipients admit under the parent id).
    async (apiKeyId) => {
      const store = new DrizzleApiKeyStore(db);
      const row = await store.findActiveById(apiKeyId);
      if (!row) return undefined;
      const children = await store.sumChildrenConsumed(apiKeyId);
      return (row.lifetimeTokensConsumed ?? 0) + children;
    },
  );
  const ipStore = redis
    ? new RedisIpAbuseStore(redis)
    : new InMemoryIpAbuseStore();
  const ipAbuseProtection = new IpAbuseProtectionService(ipStore, undefined, {
    maxRequestsPerWindow: resolveIpRateLimit(),
  });
  // Graduated model-abuse strikes: a client that keeps requesting models
  // outside its access is warned, then banned. Redis-backed when available so
  // the ban survives a restart and is shared across instances; in-memory
  // otherwise, where a restart clears it.
  const modelAbuseStore = redis ? new RedisModelAbuseStore(redis) : new InMemoryModelAbuseStore();
  const modelStrikes = new ModelStrikeService(modelAbuseStore, {
    threshold: resolveModelStrikeThreshold(),
    windowMs: resolveModelStrikeWindowMs(),
    banTtlMs: resolveModelBanTtlMs(),
  });
  const readiness = () => checkReadiness(db, redis, resolveRedisBackend(redis));
  // One list covers every periodic task: a small deployment can cut the
  // heaviest sweeps (quota refresh, OAuth refresh, client-version polling)
  // without the codebase growing a flag per task.
  const scheduledTasks = new ScheduledTaskRegistry(
    readList("CARTETHYIA_DISABLED_TASKS", CONFIG_SPEC.CARTETHYIA_DISABLED_TASKS) ?? [],
  );
  if (redis) {
    scheduledTasks.register({
      name: "lease-sweep",
      intervalMs: 30_000,
      run: () => sweepLeases(redis),
    });
  }
  scheduledTasks.register({
    name: "account-health-sweep",
    intervalMs: 30_000,
    run: async () => {
      const recovered = await sweepExpiredCooldowns(db);
      const poolRecovered = await sweepExpiredPoolCooldowns(db);
      if (recovered > 0 || poolRecovered > 0) await snapshotService.invalidate();
    },
  });
  const payloadCapture = new TelemetryPayloadCapture(db);
  const telemetryStore = new DrizzleTelemetryStore(db);
  scheduledTasks.register({
    name: "telemetry-payload-cleanup",
    intervalMs: 15 * 60_000,
    run: () => payloadCapture.cleanupExpired(),
  });
  scheduledTasks.register({
    name: "console-session-sweep",
    // Sessions live 48 h, so an hourly sweep deleted nothing 47 times out of
    // 48 — each pass a full scan of the session table for rows that cannot yet
    // be expired. Half the session lifetime is the point where a pass can
    // actually find work, and still leaves a full grace period after it.
    intervalMs: 12 * 60 * 60_000,
    run: () => deleteExpiredSessions(db),
  });
  scheduledTasks.register({
    name: "telemetry-retention",
    intervalMs: 6 * 60 * 60_000,
    run: () =>
      telemetryStore.pruneTelemetry(
        new Date(Date.now() - resolveTelemetryRetentionDays() * 24 * 60 * 60_000),
      ),
  });
  const telemetryBuffer = new TelemetryBatchBuffer(db);
  const poolSelector = new NetworkPoolSelector(redis);
  const poolAgentResolver = new PoolAgentResolver(
    new DrizzleNetworkPoolLoader(db),
    { ssrfPolicy, db },
  );
  const networkBindingFactory = new ValidatedNetworkBindingFactory(
    ssrfPolicy,
    undefined,
    poolAgentResolver,
  );
  // Runtime gauges (memory + bounded-collection sizes) sampled on the shared
  // maintenance cadence. The sampler reads live sizes through closures so the
  // observability layer never holds direct references to routing/pool state.
  const runtimeMetricsSampler = new RuntimeMetricsSampler({
    routingRoundRobinEntries: () => routingEngine.roundRobinEntries(),
    ipAbuseKeys: () => (ipStore instanceof InMemoryIpAbuseStore ? ipStore.keyCount() : 0),
    quotaCacheEntries: () => quotaCacheSize(),
    modelCatalogEntries: () => modelCatalogCacheSize(),
    // Late-bound via bindInFlight once the request state store exists.
    inFlight: () => 0,
  });
  scheduledTasks.register({
    name: "runtime-metrics",
    intervalMs: readInt(
      "CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS",
      CONFIG_SPEC.CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS,
    ),
    run: () => runtimeMetricsSampler.sample(),
  });
  scheduledTasks.register({
    name: "pool-agent-sweep",
    // `resolveAgent` already self-sweeps every 30 s, so a 1 min timer added a
    // second pass that almost always found nothing to release. 5 min is well
    // inside the idle timeout this exists to enforce, and outside the path
    // that already runs.
    intervalMs: 5 * 60_000,
    run: () => poolAgentResolver.sweepIdleAgents(),
  });
  const oauthRefreshService = new OAuthRefreshService(db);
  // Converge accounts an earlier build parked on a dead refresh grant: an
  // account whose stored access token is still usable becomes a static token
  // (and returns to rotation) instead of staying disabled for re-auth.
  await measureStartupPhase("static-token-reconciliation", () =>
    reconcileStaticTokenAccounts(db),
  );
  // Fills in the identity a batch import deliberately skipped, so a paste of
  // many credentials is one instant write and the email/label arrive shortly
  // after rather than blocking the import. Purely CPU on an already-stored
  // credential — no upstream call — so it runs often and cheaply.
  scheduledTasks.register({
    name: "account-enrichment-sweep",
    // Converges via `identity_checked_at`: once every stored credential has
    // been parsed, the listing query returns nothing — and a 30 s timer kept
    // running that empty query forever, two million times a year. 10 min is
    // still instant for the case that matters (a batch import, where the label
    // and email show up on the next tick) and costs nothing when idle.
    intervalMs: 10 * 60_000,
    run: () => accountIdentitySweep({ db }),
  });
  scheduledTasks.register({
    name: "oauth-refresh-sweep",
    intervalMs: 60_000,
    run: () =>
      oauthRefreshSweep({
        loadDueAccounts: () => loadDueOAuthAccounts(db),
        refreshService: oauthRefreshService,
        resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
        // Sequential with a pause between accounts: the OAuth token endpoints
        // rate-limit a burst of refreshes, and a pass over a handful of
        // accounts must not look like one. Per-account outcomes are already
        // pushed to the Console Log ring by `OAuthRefreshService`; this only
        // covers an error that escaped before reaching it.
        interItemDelayMs: OAUTH_REFRESH_INTER_ITEM_DELAY_MS,
        onAccountError: (accountId, providerId, error) => {
          log.error(
            `[oauth-refresh] account=${accountId} provider=${providerId} failed:`,
            error as Error,
          );
          pushStructuredConsoleLog("error", "OAuth refresh sweep: account failed", {
            event: "token_refresh",
            accountId,
            providerId,
            errorCode: "refresh_sweep_failed",
          });
        },
      }),
  });

  // Client versions are monitor-only metadata; let the listener settle before
  // starting their external fetches. The scheduled task keeps the cache warm.
  scheduledTasks.register({
    name: "client-version-monitor",
    intervalMs: CLIENT_VERSION_MONITOR_INTERVAL_MS,
    initialDelayMs: CLIENT_VERSION_INITIAL_DELAY_MS,
    run: refreshProviderClientVersions,
  });

  const quotaResolveCredential = createAccountSecretResolver({
    db,
    resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
    refreshService: oauthRefreshService,
  });
  // Keeps every account's cached quota warm so opening the Quota page is a
  // cache read. Without this the only refreshes are user-triggered, so the
  // first open after an expiry always blocks on the provider.
  //
  // It also carries the daily check-in ride-along: each account refreshed
  // here gets its once-per-day WorkBuddy/CodeBuddy credit grant claimed in
  // the same pass (one attempt per account per day, guarded by a day
  // marker), so no second timer duplicates the credential resolution.
  //
  // Registered in **every** mode, not only when Redis is present. It used to
  // sit behind `if (redis)`, which quietly cost Lite two things: proactive
  // quota warming, and the check-in ride-along above that claims the
  // once-per-day WorkBuddy/CodeBuddy credit grant. The whole sweep chain
  // already accepts `RedisClient | undefined` and falls back to the
  // in-process TTL cache and an in-process day marker, so Redis is an
  // optimization here rather than a precondition — which is exactly what
  // Lite is for.
  scheduledTasks.register({
    name: "quota-refresh-sweep",
    intervalMs: 60_000,
    // Staggered off the oauth/lease/health ticks so the three sweeps that
    // strike providerAccounts do not land together every minute.
    initialDelayMs: 20_000,
    run: () =>
      quotaRefreshSweep({
        db,
        redis,
        providerRegistry: registry,
        resolveCredential: quotaResolveCredential,
        snapshotInvalidator: snapshotService,
        // Below the 60 s interval: a budget longer than the tick guarantees
        // skip/burst under load instead of steady progress.
        passBudgetMs: 45_000,
        // The check-in ride-along rotates egress per account: each account
        // gets the next active pool in its tenant's rotation so check-ins
        // spread across IPs instead of sharing one direct egress. No pool
        // (or an unreadable pool table) falls back to direct egress, and a
        // tenant never borrows another tenant's pool.
        checkinFetcherFor: dailyCheckinEgressForPass({ db, networkBindingFactory }),
        // Per-account lines and the pass summary are emitted by the sweep
        // itself at `info` level, so they survive the production LOG_LEVEL.
        // `onTick` is left for tests.
      }),
  });
  // The buddy growth/credit tasks: one per upstream capability, each
  // independently switchable with `CARTETHYIA_DISABLED_TASKS`. Every one of
  // them is a credit gain the account is entitled to, and none of them can mark
  // an account unhealthy — a growth endpoint that 404s is a display miss, not a
  // dispatch failure.
  //
  // Daily, not hourly: each claim is once per account per day and is
  // ledger-guarded, so at an hourly cadence 23 of every 24 passes were a full
  // scan of active accounts plus a ledger read per account that resolved to
  // nothing. Once a day is the shortest interval where a pass can still find
  // work, which is the only reason to run at all.
  const buddyTaskDeps = {
    db,
    resolveCredential: quotaResolveCredential,
    fetcher: fetch,
    // Spread across accounts so a pass does not look like a burst to the
    // upstream's risk gate.
    interAccountDelayMs: 800,
  };
  scheduledTasks.register({
    name: "buddy-streak",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 5 * 60_000,
    run: () => buddyStreakTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-redeem",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 8 * 60_000,
    run: () => buddyRedeemTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-lottery",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 11 * 60_000,
    run: () => buddyLotteryTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-travel",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 14 * 60_000,
    run: () => buddyTravelTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-adopt",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 17 * 60_000,
    run: () => buddyAdoptTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-trial",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 20 * 60_000,
    run: () => buddyTrialTask(buddyTaskDeps),
  });
  // Growth-activity report: the `/v2/report` batch that lights the login streak
  // and scores the daily growth event. Once a day with its own ledger — it used
  // to ride the quota sweep with no marker of its own, so its eight POSTs ran
  // every minute.
  scheduledTasks.register({
    name: "buddy-activity-report",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 15 * 60 * 60_000,
    run: () => buddyActivityReportTask(buddyTaskDeps),
  });
  // Real credit deductions, stored so the console renders a figure the upstream
  // actually reported. Six-hourly: the upstream's own window is 30 days, so a
  // day's number does not change intraday.
  scheduledTasks.register({
    name: "buddy-usage-sync",
    intervalMs: 6 * 60 * 60_000,
    initialDelayMs: 23 * 60_000,
    run: () => syncBuddyUsage(buddyTaskDeps),
  });
  // The scheduled tasks are registered here but started by the caller once the
  // listener is actually serving (`main.ts`). Starting them inside this builder
  // would let the first tick — the lease sweep, the health sweep — run against
  // a process that has not begun accepting traffic yet.
  const deps: ProductionDeps = {
    db,
    redis,
    snapshotService,
    readRoutingAccountInflight,
    resolveProviderAdapter: (providerId) => registry.resolve(providerId),
    bundledModelCatalog: bundledCatalog,
    byokUpstreamHosts,
    proxyPreparer: new ProxyRequestPreparer({
      snapshotService,
      routingEngine,
      admissionService,
    }),
    networkBindingFactory,
    ipAbuseProtection,
    modelStrikes,
    readiness,
    scheduledTasks,
    poolAgentResolver,
    telemetryBuffer,
    usageFlush,
    healthEventFlush,
    poolSelector,
    admissionService,
    trustedProxyBoundary: resolveTrustedProxyBoundary(),
    providerRegistry: registry,
    resolveOAuthRefresher: (providerId) => registry.resolveRefresher(providerId),
    oauthRefreshService,
    runtimeMetricsSampler,
  };
  const startupMemoryAfter = process.memoryUsage();
  log.info(
    `[startup] phase=dependencies-ready elapsed_ms=${Math.round(performance.now() - startupStartedAt)} ` +
      `rss_mb=${toMiB(startupMemoryAfter.rss)} ` +
      `rss_delta_mb=${toMiB(startupMemoryAfter.rss - startupMemoryBefore.rss)} ` +
      `heap_used_mb=${toMiB(startupMemoryAfter.heapUsed)} ` +
      `heap_delta_mb=${toMiB(startupMemoryAfter.heapUsed - startupMemoryBefore.heapUsed)}`,
  );
  return deps;
}

async function measureStartupPhase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const before = process.memoryUsage();
  log.info(
    `[startup] phase=${name} status=started rss_mb=${toMiB(before.rss)} heap_used_mb=${toMiB(before.heapUsed)}`,
  );
  try {
    const result = await operation();
    const after = process.memoryUsage();
    log.info(
      `[startup] phase=${name} status=completed elapsed_ms=${Math.round(performance.now() - startedAt)} ` +
        `rss_mb=${toMiB(after.rss)} rss_delta_mb=${toMiB(after.rss - before.rss)} ` +
        `heap_used_mb=${toMiB(after.heapUsed)} heap_delta_mb=${toMiB(after.heapUsed - before.heapUsed)} ` +
        `external_mb=${toMiB(after.external)}`,
    );
    return result;
  } catch (error) {
    log.error(
      `[startup] phase=${name} status=failed elapsed_ms=${Math.round(performance.now() - startedAt)}`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  }
}

function toMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
