import {
  GENERIC_API_KEY_SPECS,
} from "./configured-openai-providers";
import { createDiscoveryBackedProviderCapabilities } from "./bundled-discovery-providers";
import { createApiKeyAdapter } from "./configured-provider";
import type { ApiKeyProviderSpec } from "./configured-provider";
import { oauthCapability, quotaCapability, type ProviderModuleCapabilities } from "./provider-capabilities";
import { BUDDY_PROVIDER_CAPABILITIES } from "./integrations/buddy/capabilities";
import { ProviderRegistry, toRegistration, type ProviderModule } from "./provider-registry";
import { BUNDLED_PROVIDER_METADATA, PROVIDER_COMPATIBILITY_PROFILES, providerBaseUrl, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily, type BundledProviderId } from "./provider-metadata";
import { createAnthropicCompatibleAdapter } from "./integrations/anthropic";
import { defineModel } from "./provider-model-definition";
import type { ProviderModelDiscovery } from "./discovery/discovery-types";
import type { ProviderDispatchContext } from "./provider-contracts";
import type { WireFamily } from "../protocol/canonical-model";
import type { CanonicalRequest } from "../protocol/canonical-model";

function configuredProvider(
  providerId: keyof typeof GENERIC_API_KEY_SPECS,
  loadModels?: ProviderModuleCapabilities["loadModels"],
): ProviderModuleCapabilities {
  return {
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS[providerId]),
    ...(loadModels === undefined ? {} : { loadModels }),
  };
}

/**
 * Builds the `loadAdapter` + `loadModelDiscovery` pair every plain bearer
 * provider needs.
 *
 * Only the base URL differs between them, so both halves are shared: the
 * adapter is the generic spec and the discovery call is a bearer
 * `GET {base}/models`. Keeping them in one function is what stops the pairing
 * from drifting — registering a provider with one half and not the other is
 * exactly how `gmi`, `nvidia`, and `fireworks` came to ship with no catalog
 * *and* no discovery, which is a provider that lists zero models with no way to
 * fetch any. `test/providers/generic-provider-completeness.test.ts` holds both.
 */
function discoveryBacked(
  providerId: string,
  spec: ApiKeyProviderSpec,
): ProviderModuleCapabilities {
  return {
    // The registry map is what discovery and probing read
    // (`discoveryPathsFor`), while the spec's copy is what the adapter
    // dispatches on. Setting only the spec leaves a discovered model resolving
    // its wire from the generic default instead of the path the adapter will
    // actually call, which is how a probe verifies one endpoint while dispatch
    // hits another.
    ...(spec.endpoint_paths_by_wire_family === undefined
      ? {}
      : { endpointPathsByWireFamily: spec.endpoint_paths_by_wire_family }),
    loadAdapter: async () => createApiKeyAdapter(spec),
    loadModelDiscovery: openAIModelDiscovery(providerId, {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  };
}

function openAIModelDiscovery(
  providerId: string,
  options?: {
    readonly transformBaseUrl?: (baseUrl: string) => string;
    readonly headers?: (credential: string) => Readonly<Record<string, string>>;
  },
): () => Promise<ProviderModelDiscovery> {
  return async () => async ({ baseUrl, credential, fetcher }) => {
    const { fetchOpenAICompatibleModels } = await import("./discovery/openai-model-discovery");
    return fetchOpenAICompatibleModels({
      baseUrl: options?.transformBaseUrl?.(baseUrl) ?? baseUrl,
      providerId,
      ...(options?.headers ? { headers: options.headers(credential) } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
  };
}

/**
 * Adapter, model, OAuth, and quota behavior keyed by canonical provider ID.
 *
 * Adapter and model references use dynamic `import()` so a provider's module
 * graph — including bespoke protobuf adapters and their large generated
 * declarations — is evaluated on first use rather than at startup. Model
 * catalogs are declared inline in flat API-key modules or complex
 * integrations, so a catalog load evaluates the same module the adapter uses;
 * the dynamic import still keeps that evaluation off the startup path.
 */
export const PROVIDER_CAPABILITIES = {
  ...BUDDY_PROVIDER_CAPABILITIES,
  openai: {
    endpointPathsByWireFamily: { chat: "/v1/chat/completions", responses: "/v1/responses" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openai")).OPENAI_SPEC),
    loadModels: async () => (await import("./integrations/openai")).OPENAI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("openai", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  anthropic: {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("./integrations/anthropic")).createAnthropicAdapter(),
    loadModels: async () => (await import("./integrations/anthropic")).ANTHROPIC_MODELS,
    loadModelDiscovery: openAIModelDiscovery("anthropic", { headers: (credential) => ({ "x-api-key": credential, "anthropic-version": "2023-06-01" }) }),
  },
  claude: {
    loadAdapter: async () => (await import("./integrations/claude/claude")).claudeAdapter,
    loadModels: async () => (await import("./integrations/claude/claude")).CLAUDE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/claude/claude-oauth"), "claudeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/claude/claude-quota"), "fetchClaudeQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverClaudeModels } = await import("./integrations/claude/claude-oauth");
      const { modelIds } = await discoverClaudeModels(credential, ...(fetcher ? [fetcher] : []));
      // `defineModel` resolves limits/pricing by model name: an exact catalog
      // row first, then the bare id, then the most-agreed row for that name
      // (date suffixes stripped). The live listing carries dated ids
      // (`claude-sonnet-4-5-20250929`) the catalog files undated, so a name
      // match is what fills their limits — a hardcoded `null` here is what
      // rendered "n/a ctx · n/a out".
      return modelIds.map((modelId) =>
        defineModel({
          id: modelId,
          providerId: "claude",
          wireFamily: "messages",
          endpoint: "/v1/messages",
          vision: true,
          reasoning: true,
          toolCall: true,
        }),
      );
    },
  },
  codex: {
    loadAdapter: async () => (await import("./integrations/codex/codex")).createCodexAdapter({ provider_id: "codex" }),
    loadModels: async () => (await import("./integrations/codex/codex")).CODEX_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/codex/codex-oauth"), "codexOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/codex/codex-quota"), "fetchCodexQuota"),
  },
  grok: {
    loadAdapter: async () => (await import("./integrations/grok/grok")).grokAdapter,
    loadModels: async () => (await import("./integrations/grok/grok")).GROK_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/grok/grok-oauth"), "grokOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/grok/grok-quota"), "fetchGrokQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/grok/grok")).fetchGrokModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  xai: {
    endpointPathsByWireFamily: { responses: "/responses" },
    loadAdapter: async () => (await import("./integrations/xai/xai")).xaiAdapter,
    loadModels: async () => (await import("./integrations/xai/xai")).XAI_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/xai/xai-oauth"), "xaiOAuthClient", { withRefresher: true }),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/xai/xai-discovery")).discoverXaiModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  antigravity: {
    loadAdapter: async () => (await import("./integrations/antigravity/antigravity")).antigravityAdapter,
    loadModels: async () => (await import("./integrations/antigravity/antigravity")).ANTIGRAVITY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/antigravity/antigravity-oauth"), "antigravityOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/antigravity/antigravity-quota"), "fetchAntigravityQuota"),
    loadModelDiscovery: async () => async ({ baseUrl, credential, fetcher }) => {
      const { discoverAntigravityModels } = await import("./integrations/antigravity/antigravity-protocol");
      return discoverAntigravityModels(credential, { baseUrl, ...(fetcher ? { fetcher } : {}) });
    },
  },
  muse: {
    loadAdapter: async () => (await import("./integrations/muse/muse")).museCodeAdapter,
    loadModels: async () => (await import("./integrations/muse/muse")).MUSE_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/muse/muse-oauth"), "museCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/muse/muse-quota"), "fetchMuseQuota"),
  },
  meta: {
    loadAdapter: async () => (await import("./integrations/meta")).metaAdapter,
    loadModels: async () => (await import("./integrations/meta")).META_MODELS,
    // No `loadAuthentication`: the Model API is a plain API key pasted from the
    // Meta developer dashboard, so the default key-only credential path applies
    // and `probeApiKeyConnectivity` is the account test.
  },
  kiro: {
    loadAdapter: async () => (await import("./integrations/kiro/kiro")).kiroAdapter,
    loadModels: async () => (await import("./integrations/kiro/kiro-catalog")).KIRO_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/kiro/kiro-oauth"), "kiroOAuthClient", {
      withRefresher: true,
    }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/kiro/kiro-quota"), "fetchKiroQuota"),
    // Kiro's model list is per-account: which models a credential reaches
    // depends on the plan it is bound to, so discovery needs the credential and
    // the account's region.
    loadModelDiscovery: async () => async ({ credential, fetcher, authState }) =>
      (await import("./integrations/kiro/kiro-discovery")).fetchKiroModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
        ...(authState === undefined ? {} : { authState }),
      }),
  },
  kimi: {
    loadAdapter: async () => (await import("./integrations/kimi/kimi")).kimiCodeAdapter,
    loadModels: async () => (await import("./integrations/kimi/kimi")).KIMI_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/kimi/kimi-oauth"), "kimiCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/kimi/kimi-quota"), "fetchKimiQuota"),
  },
  cerebras: {
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/cerebras")).CEREBRAS_SPEC),
    loadModels: async () => (await import("./integrations/cerebras")).CEREBRAS_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/cerebras"), "fetchCerebrasQuota"),
    loadModelDiscovery: openAIModelDiscovery("cerebras", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  mistral: configuredProvider(
    "mistral",
    async () => (await import("./integrations/mistral")).MISTRAL_MODELS,
  ),
  fireworks: configuredProvider("fireworks"),
  nvidia: configuredProvider("nvidia"),
  deepseek: {
    // DeepSeek dispatches on its Anthropic Messages wire at the `/anthropic`
    // root (the provider id is `deepseek`, so provider-keyed quirks resolve
    // against DeepSeek, not the Anthropic builtin), while `/v1/models`
    // discovery stays on the OpenAI-compatible host. The two surfaces are
    // separate upstreams on one provider.
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("./integrations/anthropic")).createDeepseekAnthropicAdapter(),
    loadModels: async () => (await import("./integrations/deepseek")).DEEPSEEK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("deepseek", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  gmi: configuredProvider("gmi"),
  opencode: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
    // Dispatch base, not the catalog base: `/zen/v1/models` publishes the
    // listing while `/inference/v1/models` answers 404, and a byte-exact replay
    // against `/inference/v1` returned 200 where `/zen/v1` did not.
    endpointPathsByWireFamily: {
      chat: "/inference/v1/chat/completions",
      responses: "/inference/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode/provider")).OPENCODE_FREE_SPEC),
    loadModels: async () => (await import("./integrations/opencode/provider")).OPENCODE_FREE_MODELS,
    // Free-tier filtered, unlike the generic OpenAI discovery: this provider
    // serves the free tier only, and the shared Zen listing publishes the whole
    // billed catalog alongside it.
    loadModelDiscovery: async () => async ({ baseUrl, fetcher }) => {
      const { discoverOpenCodeFreeModels } = await import("./integrations/opencode/provider");
      return discoverOpenCodeFreeModels({
        baseUrl: `${baseUrl.replace(/\/+$/, "")}/zen/v1`,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
    },
  },
  "opencode-zen": {
    endpointPathsByWireFamily: {
      chat: "/inference/v1/chat/completions",
      responses: "/inference/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode/provider")).OPENCODE_ZEN_SPEC),
    loadModels: async () => (await import("./integrations/opencode/provider")).OPENCODE_ZEN_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencode-zen", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "opencode-go": {
    // The billed Go tier serves the same two wire families as the shared Zen
    // base, under its own `/zen/go/v1` prefix. Declaring them here is what the
    // endpoint-parity test guards against the catalog's own rows: without the
    // map this provider declared no paths at all, so its gate was a no-op.
    endpointPathsByWireFamily: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode/provider")).OPENCODE_GO_SPEC),
    loadModels: async () => (await import("./integrations/opencode/provider")).OPENCODE_GO_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencode-go", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/go/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
    // The Go plan publishes a real usage surface; the anonymous free tier has
    // none (it is rate-limited by egress IP, not by a balance), so this is
    // deliberately registered on the keyed tier only.
    loadQuotaCollector: async () => (await import("./integrations/opencode/opencode-go-quota")).fetchOpenCodeGoQuota,
  },
  agentrouter: {
    loadAdapter: async () => (await import("./integrations/agentrouter/agentrouter")).createAgentRouterAdapter(),
    loadModels: async () => (await import("./integrations/agentrouter/agentrouter")).AGENTROUTER_MODELS,
  },
  gemini: {
    loadAdapter: async () => (await import("./integrations/gemini")).createGeminiAdapter(),
    loadModels: async () => {
      const gemini = await import("./integrations/gemini");
      // One module, two catalog halves: the chat rows and the Google Search
      // grounding rows are the same Gemini models on two service kinds, and
      // importing the module twice would load it twice.
      return [...gemini.GEMINI_MODELS, ...gemini.GEMINI_SEARCH_MODELS];
    },
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/gemini")).discoverGeminiModels({ credential }),
  },
  aihubmix: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/aihubmix")).AIHUBMIX_SPEC),
    loadModels: async () => (await import("./integrations/aihubmix")).AIHUBMIX_FALLBACK_MODELS,
  },
  bai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/bai")).BAI_SPEC),
    loadModels: async () => (await import("./integrations/bai")).BAI_FALLBACK_MODELS,
  },
  tokenharbor: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/tokenharbor")).TOKENHARBOR_SPEC),
    loadModels: async () => (await import("./integrations/tokenharbor")).TOKENHARBOR_FALLBACK_MODELS,
  },
  cline: {
    loadAdapter: async () => (await import("./integrations/cline/cline")).createClineAdapter(),
    loadModels: async () => (await import("./integrations/cline/cline")).CLINE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/cline/cline-oauth"), "clineOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/cline/cline-quota"), "fetchClineQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { fetchClineRecommendedModels, clineAccountHasPass } = await import("./integrations/cline/cline");
      const transport = fetcher ?? globalThis.fetch;
      // A pass account may use every bucket the roster publishes, including
      // `clinePass` and `clineCloud`; a free account must not have those rows
      // persisted, because dispatching one can only 401. The plan endpoint is
      // the same one the quota collector already reads.
      const pass = credential.length > 0 && (await clineAccountHasPass(credential, transport));
      return fetchClineRecommendedModels(undefined, pass, transport);
    },
  },
  kilo: {
    loadAdapter: async () => (await import("./integrations/kilo/kilo")).kiloAdapter,
    loadModels: async () => (await import("./integrations/kilo/kilo")).KILO_MODELS,
    // No `withRefresher`: Kilo Code has no refresh grant, so this client
    // declares no refresher and the stored token is used exactly as issued.
    // Registering one would make the 401 retry path call a method that always
    // throws, turning a recoverable auth failure into a permanent one.
    loadAuthentication: oauthCapability(() => import("./integrations/kilo/kilo-oauth"), "kiloOAuthClient"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/kilo/kilo-discovery")).discoverKiloModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  commandcode: {
    loadAdapter: async () => (await import("./integrations/commandcode/commandcode")).createCommandCodeAdapter(),
    loadModels: async () => (await import("./integrations/commandcode/commandcode")).COMMANDCODE_MODELS,
  },
  qoder: {
    loadAdapter: async () => (await import("./integrations/qoder/qoder")).createQoderAdapter(),
    loadModels: async () => (await import("./integrations/qoder/qoder")).QODER_MODELS,
    // No `withRefresher`: the upstream refresh endpoint answers 403 for the
    // device flow, so the issued token is used exactly as issued until the
    // operator re-runs login — same shape as Kilo Code.
    loadAuthentication: oauthCapability(() => import("./integrations/qoder/qoder-oauth"), "qoderOAuthClient"),
  },
  inferhub: {
    loadAdapter: async () => (await import("./integrations/inferhub")).createInferhubAdapter(),
    loadModels: async () => (await import("./integrations/inferhub")).INFERHUB_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/inferhub"), "fetchInferhubQuota"),
  },
  hermes: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/hermes")).HERMES_SPEC),
    loadModels: async () => (await import("./integrations/hermes")).HERMES_MODELS,
    // `/v1/models` is open and states each row's real limits, so the free
    // allowance tracks upstream instead of a hand-kept list. The static list
    // above stays as the offline fallback for a fetch that fails.
    loadModelDiscovery: async () => async ({ baseUrl, fetcher }) => {
      const { discoverHermesFreeModels } = await import("./integrations/hermes");
      return discoverHermesFreeModels({
        baseUrl,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
    },
  },
  openrouter: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openrouter/provider")).OPENROUTER_SPEC),
    // One dynamic import for both halves: this registry lazy-loads every
    // provider module on first use, so importing the same spec twice would
    // load it twice and hand back two module records for one file.
    loadModels: async () => {
      const spec = await import("./integrations/openrouter/provider");
      return [...spec.OPENROUTER_MODELS, ...spec.OPENROUTER_FREE_MODELS];
    },
    loadModelDiscovery: async () => async (input) => {
      const spec = await import("./integrations/openrouter/provider");
      // The free tier and the billed catalog are separate registrations: the
      // free fetch is what the model list groups as "Free models (auto)", and
      // discovery merges it with the provider's ordinary listing.
      const [billed, free] = await Promise.all([
        spec.discoverOpenrouterModels(input),
        spec.discoverOpenrouterFreeModels(input),
      ]);
      if (billed === null) return null;
      return [...billed, ...(free ?? [])];
    },
    // No `withRefresher`: the PKCE exchange returns a durable API key rather
    // than an access token, so there is no refresh grant to register. The key
    // is stored as an ordinary credential and forwarded as the bearer, which is
    // why the same adapter serves the pasted-key and signed-in cases.
    loadAuthentication: oauthCapability(() => import("./integrations/openrouter/oauth"), "openrouterOAuthClient"),
  },
  xiaomipg: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMIPG_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  xiaomitp: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMITP_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  zcode: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/zcode/provider")).ZCODE_SPEC),
    loadModels: async () => (await import("./integrations/zcode/provider")).ZCODE_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/zcode/provider")).discoverZcodeModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    // No `withRefresher`: the sign-in flow ends by minting a durable API key,
    // and Z.AI publishes no refresh grant for it (`refresh "none"` upstream).
    loadAuthentication: oauthCapability(() => import("./integrations/zcode/oauth"), "zcodeOAuthClient"),
  },
  "factory": {
    loadAdapter: async () => (await import("./integrations/factory/factory")).factoryAdapter,
    // Factory publishes no model-listing endpoint — the roster is a client-side
    // registry narrowed per account by feature flags and org policy — so the
    // static catalog is the only list this provider has.
    loadModels: async () => (await import("./integrations/factory/factory-models")).FACTORY_MODELS,
    // WorkOS re-authenticates against the same token endpoint the device flow
    // used, so a real refresh grant exists. Registering no refresher here would
    // make an expired access token a dead account instead of a recoverable one.
    loadAuthentication: oauthCapability(
      () => import("./integrations/factory/factory-oauth"),
      "factoryOAuthClient",
      { withRefresher: true },
    ),
  },
  "cloudflareai": {
    loadAdapter: async () =>
      (await import("./integrations/cloudflareai/cloudflareai")).cloudflareaiAdapter,
    // No `withRefresher`: a gateway token is durable and Cloudflare publishes no
    // refresh grant for it. The client mirrors `access` into the `refresh` slot
    // because `refresh_ciphertext` is NOT NULL, and never presents it anywhere.
    loadAuthentication: oauthCapability(
      () => import("./integrations/cloudflareai/cloudflareai-oauth"),
      "cloudflareaiOAuthClient",
    ),
    // No discovery: the model list lives behind the per-account path segments
    // the credential carries, so a resolver built from the registry base URL
    // would ask the origin for a list no gateway serves. The static roster is
    // the Anthropic route; see `cloudflareai-models.ts`.
    loadModels: async () =>
      (await import("./integrations/cloudflareai/cloudflareai-models")).CLOUDFLAREAI_MODELS,
  },
  "alibabacp": {
    loadAdapter: async () =>
      (await import("./integrations/alibabacp/alibabacp")).alibabacpAdapter,
    // No `withRefresher`, same reason as the gateway token: the plan key is
    // durable and there is no grant to present.
    loadAuthentication: oauthCapability(
      () => import("./integrations/alibabacp/alibabacp-oauth"),
      "alibabacpOAuthClient",
    ),
    // Both plans publish the same model ids on their own hosts, so one static
    // catalog serves either region; which host a key reaches is per-account
    // state in the credential, resolved at dispatch.
    loadModels: async () =>
      (await import("./integrations/alibabacp/alibabacp-models")).ALIBABACP_MODELS,
  },
  perplexity: {
    loadAdapter: async () => (await import("./integrations/perplexity")).createPerplexityAdapter(),
    loadModels: async () => (await import("./integrations/perplexity")).PERPLEXITY_MODELS,
  },
  // Web-search providers: a `createSearchAdapter` over their spec, and a single
  // `serviceKind: "websearch"` catalog row served by the `/v1/search` route.
  exa: {
    loadAdapter: async () =>
      (await import("./search/search-provider")).createSearchAdapter(
        (await import("./search/search-providers")).SEARCH_PROVIDER_SPECS.exa,
      ),
    loadModels: async () => (await import("./search/search-catalog")).EXA_SEARCH_MODELS,
  },
  parallel: {
    loadAdapter: async () =>
      (await import("./search/search-provider")).createSearchAdapter(
        (await import("./search/search-providers")).SEARCH_PROVIDER_SPECS.parallel,
      ),
    loadModels: async () => (await import("./search/search-catalog")).PARALLEL_SEARCH_MODELS,
  },
  "github": {
    // Chat only. Copilot also serves some SKUs on `/responses`, but those arrive
    // through discovery, which carries its own endpoint path with the wire
    // family it read from `supported_endpoints` — this map is the static floor,
    // and the static catalog is all chat.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => (await import("./integrations/github/github")).githubAdapter,
    loadModels: async () => (await import("./integrations/github/github")).GITHUB_MODELS,
    // The Copilot token is short-lived and re-minted from the GitHub token the
    // device flow issued, so this provider registers a real refresher.
    loadAuthentication: oauthCapability(() => import("./integrations/github/github-oauth"), "githubOAuthClient", { withRefresher: true }),
    // The account's own `/models` is authoritative: it names the SKUs the
    // subscription may use and the surface each answers on.
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/github/github-discovery")).discoverGithubModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/github/github-quota"), "fetchGithubQuota"),
  },
  ollamacloud: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
    endpointPathsByWireFamily: {
      chat: "/chat/completions",
      responses: "/responses",
    },
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS.ollamacloud),
    loadQuotaCollector: quotaCapability(() => import("./integrations/ollamacloud-quota"), "fetchOllamaQuota"),
    loadModelDiscovery: openAIModelDiscovery("ollamacloud", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },

  ...createDiscoveryBackedProviderCapabilities(openAIModelDiscovery),

  coreweave: {
    // Same OpenAI-compatible bearer wire as every other aggregator, plus one
    // requirement none of the shared shapes express: CoreWeave refuses every
    // request that lacks `OpenAI-Project: <team>/<project>`.
    //
    // The value is per-account — one deployment may hold accounts on different
    // teams — so it lives in the account's `auth_state` and is injected per
    // dispatch through the adapter's `buildExtraHeaders` hook. A static
    // `extra_headers` value would pin every account to one team.
    ...endpointPathsOf(GENERIC_API_KEY_SPECS.coreweave),
    loadAdapter: async () =>
      createApiKeyAdapter({
        ...GENERIC_API_KEY_SPECS.coreweave,
        // `OpenAI-Project` is not in `BASE_PROTECTED_HEADERS`, so an operator
        // may also set it as a per-account custom header. Reading both means an
        // account configured either way dispatches.
        buildExtraHeaders: (context) => {
          const project = readCoreWeaveProject(context);
          return project === undefined ? {} : { "OpenAI-Project": project };
        },
      }),
    loadModelDiscovery: openAIModelDiscovery("coreweave", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },

  // Qwen Portal rejects more than one system message with a 500 from its default
  // chat template, so its system parts are coalesced before serialization rather
  // than emitted as separate blocks.
  "qwen-portal": {
    ...endpointPathsOf(GENERIC_API_KEY_SPECS["qwen-portal"]),
    loadAdapter: async () =>
      createApiKeyAdapter({
        ...GENERIC_API_KEY_SPECS["qwen-portal"],
        prepareRequest: coalesceSystemParts,
      }),
    loadModelDiscovery: openAIModelDiscovery("qwen-portal", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  // Live discovery over a static floor: `/v1/models` answers on this host, so a
  // synced account sees whatever the plan currently serves. The catalog keeps
  // the provider usable before anyone syncs.
  dashscope: {
    ...discoveryBacked("dashscope", GENERIC_API_KEY_SPECS.dashscope),
    loadModels: async () => (await import("./integrations/dashscope-models")).DASHSCOPE_MODELS,
  },

// Anthropic-Messages providers reached with a plain key. The wire path is
  // appended to the base, so each base URL already carries the surface's root
  // (`/anthropic`, or the bare host for Umans) exactly as DeepSeek's does.
  minimax: anthropicWireProvider("minimax"),
  minimaxcode: anthropicWireProvider("minimaxcode"),
  minimaxcodecn: anthropicWireProvider("minimaxcodecn"),
  umans: anthropicWireProvider("umans"),

} satisfies Readonly<Record<BundledProviderId, ProviderModuleCapabilities>>;

/**
 * Joins every system part into one, for providers whose chat template rejects
 * more than one system message.
 *
 * Qwen Portal answers a 500 from its default template when a request carries
 * several system blocks, so the parts are merged before serialization rather
 * than after — the split happens in `canonicalToChatPayload`, below this hook,
 * so coalescing the request is the only seam that reaches it.
 *
 * Non-text parts are dropped rather than stringified: they carry data the chat
 * wire has no representation for, and this provider's chat surface does not
 * accept them. A single part is returned untouched, so a request that was
 * already well-formed is byte-identical to what it would have been.
 */
function coalesceSystemParts(request: CanonicalRequest): CanonicalRequest {
  const parts = request.system ?? [];
  if (parts.length < 2) return request;
  const text = parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((value) => value.length > 0);
  if (text.length === 0) return { ...request, system: [] };
  if (text.length === 1) return { ...request, system: [{ kind: "text", text: text[0]! }] };
  return { ...request, system: [{ kind: "text", text: text.join("\n\n") }] };
}

/**
 * An Anthropic-Messages provider authenticated with a plain key.
 *
 * Discovery is the one wrinkle: the dispatch base carries the `/anthropic`
 * root, and `/v1/models` is published at the host root above it, so the
 * discovery call strips the suffix rather than asking the Messages surface for
 * a listing it does not serve. Without the strip every model lookup 404s and the
 * provider lists nothing.
 */
function anthropicWireProvider(
  providerId: "minimax" | "minimaxcode" | "minimaxcodecn" | "umans",
): ProviderModuleCapabilities {
  return {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () =>
      createAnthropicCompatibleAdapter({
        provider_id: providerId,
        base_url: providerBaseUrl(providerId),
      }),
    loadModelDiscovery: openAIModelDiscovery(providerId, {
      transformBaseUrl: (baseUrl) => baseUrl.replace(/\/anthropic$/, ""),
      headers: (credential) => ({
        "x-api-key": credential,
        "anthropic-version": "2023-06-01",
      }),
    }),
  };
}

/**
 * The registry map form of a spec's endpoint paths, or nothing when the spec
 * declares none. `exactOptionalPropertyTypes` forbids assigning `undefined` to
 * an optional property, so the spread is the way to say "omit this key".
 */
function endpointPathsOf(spec: ApiKeyProviderSpec): {
  endpointPathsByWireFamily?: Readonly<Partial<Record<WireFamily, string>>>;
} {
  return spec.endpoint_paths_by_wire_family === undefined
    ? {}
    : { endpointPathsByWireFamily: spec.endpoint_paths_by_wire_family };
}

/**
 * The CoreWeave project this account is bound to, or `undefined` when it has
 * none.
 *
 * Reads `auth_state` first because that is where the console persists it when
 * an account is created, then falls back to the account's custom headers so an
 * operator who set the header on the account instead still dispatches. A
 * missing value is not an error here: the upstream answers 401 with a message
 * naming the header, and failing closed here with our own prose would replace
 * a precise upstream answer with a vaguer one.
 */
function readCoreWeaveProject(context: ProviderDispatchContext): string | undefined {
  const fromAuthState = context.credential.auth_state?.["coreweaveProject"];
  if (typeof fromAuthState === "string" && fromAuthState.trim().length > 0) {
    return fromAuthState.trim();
  }
  const fromHeaders = context.credential.custom_headers?.["openai-project"];
  return typeof fromHeaders === "string" && fromHeaders.trim().length > 0
    ? fromHeaders.trim()
    : undefined;
}

/** Canonical provider registry; every provider subsystem consumes these rows. */
export const BUNDLED_PROVIDER_MODULES: readonly ProviderModule[] = BUNDLED_PROVIDER_METADATA.map((definition) => {
  const implementation = PROVIDER_CAPABILITIES[definition.id];
  if (implementation === undefined) throw new Error(`Missing provider implementation: ${definition.id}`);
  const compatibility = PROVIDER_COMPATIBILITY_PROFILES[definition.id];
  return {
    id: definition.id,
    displayName: definition.displayName,
    baseUrl: definition.baseUrl,
    serviceKinds: definition.serviceKinds,
    defaultSkipProxy: definition.defaultSkipProxy,
    ...implementation,
    upstreamHost: providerUpstreamHost(definition.id),
    ...(compatibility === undefined ? {} : { compatibility }),
    wireFamilyDefault: providerDefaultWireFamily(definition.id),
    requiresAccount: providerRequiresAccount(definition.id),
  };
});

/**
 * Eagerly composes the default provider registry from the canonical
 * bundled module. Registration itself is direct and synchronous; each
 * provider's adapter and model catalog still load lazily through
 * capability loader, so protobuf-heavy adapters stay out of the
 * startup path.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of BUNDLED_PROVIDER_MODULES) {
    registry.register(toRegistration(provider));
  }
  return registry;
}
