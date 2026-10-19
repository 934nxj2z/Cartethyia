/**
 * Offline model catalog: limits, capabilities, and pricing for every model the
 * bundled providers can route to.
 *
 * The data is a packed, brotli-compressed binary blob (`catalog-blob.ts`, built
 * by `scripts/generate/models-catalog.ts`) read through {@link PackedCatalog}.
 * There is no JSON parse and no per-row object: a lookup is a binary search
 * over a typed-array column, and the metadata object for a row is built only
 * when something asks for that row.
 *
 * Sources, both fetched by the generator:
 * - **models.dev** — the broad catalog and the only per-model pricing.
 * - **models.opencode.ai** — the authoritative limits for the OpenCode family,
 *   whose dispatch listing (`/zen/v1/models`) publishes ids with no limits at
 *   all. Without it every fetched OpenCode model published an invented
 *   200k/64k.
 *
 * Runtime network access is intentionally absent: a deployed instance uses the
 * exact catalog selected at build time.
 */
import { brotliDecompressSync } from "node:zlib";
import {
  lowerAscii,
  PackedCatalog,
  type ModelsDevModelCost,
  type ModelsDevModelMetadata,
} from "./catalog/catalog-format";
import {
  CATALOG_BLOB_BROTLI_BASE64,
  CATALOG_BLOB_BYTES,
} from "./catalog/catalog-blob";

export type { ModelsDevModelCost, ModelsDevModelMetadata };

/**
 * Cartethyia provider id → the provider key the catalog files it under.
 *
 * Only ids that genuinely differ belong here, and each entry is backed by the
 * deployment's own upstream: `opencode` serves `opencode.ai`, and its model
 * ids also appear under the catalog's `opencode`. Without this the exact
 * lookup missed for every one of those models, so each fell through to the bare
 * lookup — which fails closed when providers disagree — and the entry was
 * published with invented defaults.
 *
 * Deliberately absent: providers with no catalog counterpart (a private
 * gateway, a BYOK endpoint) and any id whose match rests on model ids alone.
 * A shared model id is not proof of identity — the same generic id appears
 * under hundreds of resellers — so a guess here would attribute a stranger's
 * limits to this gateway's serving, which is the exact failure this catalog's
 * disagreement rule exists to prevent.
 *
 * This table is for **metadata** (limits, modalities), where a wrong row is
 * harmful and failing closed is right. Pricing does not need it: see
 * {@link ModelsDevCatalog.costFor}, which falls back to the model's own rate.
 */
const CATALOG_PROVIDER_IDS: Readonly<Record<string, string>> = {
  // `opencode` is both a Cartethyia provider id and a catalog key, so it needs
  // no entry: `exactMetadata` tries the id directly first. Only the tiers whose
  // id differs from the catalog key belong here.
  "opencode-zen": "opencode",
  "opencode-go": "opencode-go",
  ollamacloud: "ollama-cloud",
  xiaomipg: "xiaomi-token-plan-sgp",
  xiaomitp: "xiaomi-token-plan-cn",
  // Cartethyia ids that are shorter than the name the catalog files the
  // provider under. Without these the exact lookup misses for every model, and
  // each row falls through to the bare lookup — which fails closed when
  // providers disagree about the id — so the catalog would publish invented
  // defaults.
  github: "github-copilot",
  // Discovery-backed aggregators whose catalog key is spelled differently.
  // `qianfan` and `helmcode` are deliberately absent: the catalog files no rows
  // for either, and an entry pointing at a provider it does not carry would
  // make every lookup miss and publish invented limits.
  siliconflowcn: "siliconflow-cn",
  nanogpt: "nano-gpt",
  novita: "novita-ai",
  together: "togetherai",
  wafer: "wafer.ai",
  // The Token Plan and the mainland DashScope host. Each points at the key the
  // catalog files the *same* service under, so without these every one of their
  // rows missed the exact lookup and fell through to the bare one, which fails
  // closed when providers disagree about an id that resellers share.
  //
  // `cloudflareai` is deliberately absent: the gateway files its rows as
  // `anthropic/claude-opus-5` while the provider dispatches the bare
  // `claude-opus-5`, so the exact lookup misses under either key. An entry here
  // would only restate the miss.
  alibabacp: "alibaba-token-plan",
  dashscope: "alibaba-coding-plan-cn",
};

/**
 * Removes a trailing release date from a model id, in either spelling the
 * catalog uses: `-YYYY-MM-DD` (`gpt-4o-2024-11-20`) or `-YYYYMMDD`
 * (`claude-haiku-4-5-20251001`). A dated snapshot bills the same rate as the
 * model it snapshots, so both forms must reach the same row.
 */
function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

/**
 * Suffixes a reseller appends to a model id it republishes unchanged.
 *
 * OpenRouter lists `deepseek/deepseek-v4.1-flash:free` — the `:free` marks its
 * own billing tier, not a different model, so the underlying row is the one
 * carrying the real context and output limits. `@variant` is the same idea (a
 * pinned quantization or provider route).
 *
 * Stripped for *lookup only* — the id sent upstream is always the caller's.
 */
function stripVariantSuffix(modelId: string): string {
  return modelId.replace(/[:@][^/@:]*$/, "");
}

/**
 * The bare id: what follows a reseller's `provider/` prefix, if any.
 *
 * Returned as bytes because every lookup compares against the packed blob
 * without allocating a string.
 */
function bareBytes(idLower: Uint8Array): Uint8Array {
  for (let i = 0; i < idLower.length; i += 1) {
    if (idLower[i] === 0x2f /* "/" */) return idLower.subarray(i + 1);
  }
  return idLower;
}

const UNKNOWN_COST: ModelsDevModelCost = {
  input: null,
  output: null,
  pricing_model: "unknown",
};

/**
 * The packed catalog, decompressed on first use and memoized.
 *
 * Brotli + base64, not `JSON.parse`: the blob is columnar, so this allocates
 * one buffer and takes typed-array views over it rather than materialising
 * 8900 objects. `CATALOG_BLOB_BYTES` is the decompressed length, checked here
 * so a consumer paired with a half-regenerated blob fails on first access
 * rather than resolving a truncated catalog.
 *
 * The decode is lazy on purpose. It is ~105 KB of base64 that expands to a
 * much larger buffer, and it used to run at module load — so every process,
 * including the ones that never resolve a model (a CLI subcommand, a migration
 * run, a test that only touches the console), paid it on the boot path.
 * Deferring it moves that cost to the first catalog lookup and pays it once.
 */
let catalogCache: PackedCatalog | undefined;

function catalog(): PackedCatalog {
  const cached = catalogCache;
  if (cached !== undefined) return cached;
  const bytes = brotliDecompressSync(Buffer.from(CATALOG_BLOB_BROTLI_BASE64, "base64"));
  if (bytes.byteLength !== CATALOG_BLOB_BYTES) {
    throw new Error(
      `The packed model catalog is ${bytes.byteLength} B, expected ` +
        `${CATALOG_BLOB_BYTES} B — regenerate it.`,
    );
  }
  // `PackedCatalog` copies into a 4-byte-aligned buffer of its own, so the
  // decompressed buffer is dropped here rather than held beside the copy.
  const packed = new PackedCatalog(bytes);
  catalogCache = packed;
  return packed;
}

/**
 * Resolves model metadata and pricing exclusively from the packed base catalog
 * shipped with Cartethyia.
 */
export class ModelsDevCatalog {
  /** When the generator fetched the upstream catalogs. */
  get fetchedAt(): string {
    return catalog().fetchedAt;
  }
  /** Every provider key the catalog files. */
  get providers(): readonly string[] {
    return catalog().providers;
  }

  /**
   * Metadata for an exact `(providerIndex, idLower)` pair, or `undefined`.
   *
   * The provider is tried as given first and then under its mapped key: the
   * mapped name is a second chance, not a replacement, so an id that already
   * matches exactly keeps winning.
   */
  private exactMetadata(providerLower: string, idLower: Uint8Array): ModelsDevModelMetadata | undefined {
    const direct = catalog().exactIndex(catalog().providerIndex(providerLower), idLower);
    if (direct >= 0) return catalog().metadataAt(direct);
    const mapped = CATALOG_PROVIDER_IDS[providerLower];
    if (mapped === undefined) return undefined;
    return catalog().metadataAt(catalog().exactIndex(catalog().providerIndex(mapped), idLower));
  }

  /** Metadata rows whose *bare* id equals `bare`, in catalog order. */
  private metadataForBare(bare: Uint8Array): ModelsDevModelMetadata[] {
    const [start, end] = catalog().bareRange(bare);
    const out: ModelsDevModelMetadata[] = [];
    for (let position = start; position < end; position += 1) {
      const metadata = catalog().metadataAt(catalog().bareOrderAt(position));
      if (metadata !== undefined) out.push(metadata);
    }
    return out;
  }

  /**
   * Resolves metadata for one model id.
   *
   * An exact `provider:model` hit always wins — it is the only lookup that
   * names the provider actually serving the request. The bare-id fallback is
   * used only when it is **unambiguous**: if the catalog recorded the id under
   * several providers with different facts, no row can be called the model's
   * own, so the answer is `undefined` and the caller keeps its own declared
   * limits instead of inheriting a stranger's.
   *
   * Callers that know the provider should pass it; passing `""` opts into the
   * bare lookup, which is why it fails closed on disagreement.
   */
  resolve(providerId: string, modelId: string): ModelsDevModelMetadata | undefined {
    const provider = providerId.trim().toLowerCase();
    const idLower = lowerAscii(modelId);
    if (idLower.length === 0) return undefined;
    const exact = this.exactMetadata(provider, idLower);
    if (exact !== undefined) return exact;
    // A reseller suffix is the reseller's, not the model's: retry the exact
    // lookup without it before falling through to the bare id. Doing this here
    // rather than stripping up front keeps the provider-scoped match.
    const unsuffixedText = stripVariantSuffix(modelId.trim().toLowerCase());
    if (unsuffixedText !== modelId.trim().toLowerCase()) {
      const unsuffixed = this.exactMetadata(provider, lowerAscii(unsuffixedText));
      if (unsuffixed !== undefined) return unsuffixed;
    }
    const bare = bareBytes(idLower);
    const unambiguous = this.unambiguousBare(bare);
    if (unambiguous !== undefined) return unambiguous;
    const strippedText = stripDateSuffix(modelId.trim().toLowerCase());
    const bareText = new TextDecoder().decode(bare);
    if (strippedText !== bareText) {
      const dated = this.unambiguousBare(lowerAscii(strippedText));
      if (dated !== undefined) return dated;
    }
    // Last chance: the bare id may carry a reseller suffix of its own
    // (`provider/model:free` → bare `model:free`).
    const unsuffixedBareText = stripVariantSuffix(bareText);
    if (unsuffixedBareText !== bareText && unsuffixedBareText !== strippedText) {
      return this.unambiguousBare(lowerAscii(unsuffixedBareText));
    }
    return undefined;
  }

  /**
   * The single row for a bare id, or `undefined` when the catalog disagrees.
   *
   * Two rows that agree on every reported fact are interchangeable, so the
   * first is returned rather than treating agreement as ambiguity.
   */
  private unambiguousBare(bare: Uint8Array): ModelsDevModelMetadata | undefined {
    const rows = this.metadataForBare(bare);
    const first = rows[0];
    if (first === undefined) return undefined;
    if (rows.length === 1) return first;
    const signature = (metadata: ModelsDevModelMetadata): string =>
      JSON.stringify([metadata.contextLimit, metadata.outputLimit, metadata.cost, metadata.modalities]);
    const expected = signature(first);
    for (const row of rows) {
      if (signature(row) !== expected) return undefined;
    }
    return first;
  }

  /**
   * The most widely agreed row for a bare id, or `undefined` when nothing
   * records it.
   *
   * `resolve`/`unambiguousBare` fail closed on any disagreement, which is right
   * when the caller can leave a limit unstated. A caller that must publish a
   * number for a model the catalog knows about but disagrees on — a roster
   * whose own upstream reports nothing, where the alternative is a fixed
   * default — is better served by the majority answer: 18 of 19 rows file
   * `claude-opus-5` as 1000000/128000, and the single dissenter (a reseller's
   * 64k output cap) is the outlier, not the model.
   *
   * The vote is per-field and only among rows that state the field, so a row
   * omitting `output` cannot win that field by abstaining. Ties resolve to the
   * larger value: a limit stated too low truncates a caller's work, while one
   * stated too high is caught by the provider.
   */
  majorityFor(modelId: string): { contextLimit: number; outputLimit: number } | undefined {
    const idLower = lowerAscii(modelId);
    const bare = bareBytes(idLower);
    // The bare index is keyed by the id as filed, so a dated spelling needs its
    // undated form tried too. Merge rather than pick: both name one model.
    const bareText = new TextDecoder().decode(bare);
    const rows = [
      ...this.metadataForBare(bare),
      ...(stripDateSuffix(bareText) === bareText
        ? []
        : this.metadataForBare(lowerAscii(stripDateSuffix(bareText)))),
    ];
    if (rows.length === 0) return undefined;
    const vote = (values: ReadonlyArray<number | null>): number | undefined => {
      const counts = new Map<number, number>();
      for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      let best: number | undefined;
      let bestCount = 0;
      for (const [value, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
          best = value;
          bestCount = count;
        }
      }
      return best;
    };
    const contextLimit = vote(rows.map((row) => row.contextLimit));
    const outputLimit = vote(rows.map((row) => row.outputLimit));
    if (contextLimit === undefined && outputLimit === undefined) return undefined;
    return {
      contextLimit: contextLimit ?? outputLimit ?? 0,
      outputLimit: outputLimit ?? contextLimit ?? 0,
    };
  }

  /**
   * The price to bill for `modelId`, preferring the routed provider's own row.
   *
   * Unlike {@link resolve}, this does **not** fail closed when the provider has
   * no row: a gateway that republishes a model without publishing its own rate
   * still owes a cost, and the model's own global rate is the honest answer.
   * `resolve` keeps its fail-closed metadata rule — a wrong context limit is
   * harmful, while a missing price makes every request on that route read
   * `$0.00` as if it were measured.
   */
  costFor(providerId: string, modelId: string): ModelsDevModelCost {
    if (modelId.trim().length === 0 && providerId.trim().length === 0) return UNKNOWN_COST;
    const own = this.resolve(providerId, modelId)?.cost;
    if (own !== undefined && (typeof own.input === "number" || typeof own.output === "number")) {
      return own;
    }
    const idLower = lowerAscii(modelId);
    const row = catalog().globalCostRow(bareBytes(idLower));
    const global = row >= 0 ? catalog().rowCost(row) : undefined;
    if (global !== undefined && global.pricing_model !== "unknown") return global;
    return own ?? global ?? UNKNOWN_COST;
  }
}

export const modelsDevCatalog = new ModelsDevCatalog();
