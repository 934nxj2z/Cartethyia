// Trae credential refresh.
//
// Trae is OAuth2 in the narrow sense that matters operationally: the persisted
// credential is an access/refresh token pair, and the refresh token is what
// keeps the account alive. There is no device-code or PKCE authorize endpoint
// in the donor — credentials enter the gateway as a desktop client export — so
// the only flow implemented here is the token exchange.
//
// The exchange is `POST /cloudide/api/v3/trae/oauth/ExchangeToken` with a fixed
// client id. Upstream's client secret is the literal string `"-"`, which is
// upstream fact rather than a placeholder we failed to fill.
//
// Rotation is the rule that shapes the return value: every exchange returns a
// NEW refresh token and invalidates the one sent. A refresh that persisted only
// the access token would leave the account holding a dead refresh token and
// unrecoverable on its next expiry.
//
// Sourced from the donor hub `Public/trae2api-hub` (`_refresh_account_request`
// in `trae_client.py`).

import { OAuthClient } from "../../authentication/oauth-client";
import type { OAuthExchangeResult, OAuthImportInput } from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import {
  TRAE_EXCHANGE_TOKEN_PATH,
  traeAccountCandidates,
  type TraeRealm,
} from "./trae-realm";

/** Upstream client id. Constant across realms. */
const TRAE_CLIENT_ID = "ono9krqynydwx5";

/**
 * Upstream client secret.
 *
 * Literally `"-"` as the desktop client sends it. Not a missing value.
 */
const TRAE_CLIENT_SECRET = "-";

/**
 * Response envelope: the payload is nested under `Result`, and the error
 * carries `Code`/`Message` at the top level.
 */
interface TraeExchangeResult {
  readonly Token?: string;
  readonly RefreshToken?: string;
  /** Access-token expiry, epoch milliseconds. */
  readonly TokenExpireAt?: number;
  /** Refresh-token expiry, epoch milliseconds. */
  readonly RefreshExpireAt?: number;
  readonly TokenExpireDuration?: number;
  readonly UserJwt?: string;
}

interface TraeExchangeResponse extends TraeExchangeResult {
  readonly Result?: TraeExchangeResult;
  readonly Code?: string | number;
  readonly Message?: string;
}

export class TraeOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "Trae";
  protected override readonly clientId = TRAE_CLIENT_ID;
  /** The exchange is per-realm: CN and intl use different account hosts. */
  protected override readonly tokenUrl = "";
  protected override readonly scopes = "";

  private readonly realm: TraeRealm;

  constructor(fetchFn: typeof fetch = globalThis.fetch, realm: TraeRealm = "intl") {
    super(fetchFn);
    this.realm = realm;
  }

  /**
   * Validates a pasted Trae export and stores it as a refreshable account.
   *
   * Trae has no authorize endpoint to click through, so the operator pastes
   * the credential the desktop client already minted. Importing it through this
   * path rather than the API-key path is what puts the refresh token in
   * `refresh_ciphertext` — an account imported as a plain key has no refresh
   * token stored and dies at expiry with nothing to exchange.
   *
   * `importFields` is left empty: the export carries everything needed, and
   * asking the operator for a field the blob already contains invites a
   * mismatch with the account the token belongs to.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const parsed = parseExport(input.credential);
    if (parsed === undefined) {
      // A Trae PAT *is* a refresh token, so the one-token form is accepted
      // here and exchanged below rather than being stored as a dead access
      // token.
      throw new Error(
        "Paste a Trae account export (JSON with accessToken + refreshToken), a PAT, or a refresh token",
      );
    }

    // A full export already carries a usable access token; storing it directly
    // avoids spending the refresh rotation on a credential that is still valid.
    if (parsed.refresh === undefined && parsed.expiresAtMs !== undefined) {
      return parsedResult(parsed, parsed.access, parsed.access, true);
    }
    if (parsed.refresh !== undefined && parsed.expiresAtMs !== undefined) {
      return parsedResult(parsed, parsed.access, parsed.refresh, false);
    }

    // Only a refresh token (a PAT, or a bare token with no expiry): exchange it
    // now. Upstream is the only source of the access token and of the account
    // identity, and the exchange also proves the credential is live before it
    // is stored — an import that failed here would otherwise surface as a
    // dispatch failure much later.
    const exchanged = await this.refreshWithUser(parsed.refresh ?? parsed.access, parsed.userId ?? "");
    return {
      access: exchanged.access,
      refresh: exchanged.refresh ?? (parsed.refresh ?? parsed.access),
      expiresAt: exchanged.expiresAt,
      ...(parsed.email === undefined ? {} : { accountLabel: parsed.email }),
      ...(parsed.userId === undefined
        ? {}
        : { auth_state: { userId: parsed.userId } }),
    };
  }

  /**
   * Exchanges a refresh token for a fresh access token.
   *
   * `userId` is part of the payload upstream: the exchange is addressed per
   * account, not per client.
   */
  async refreshWithUser(
    refreshToken: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const hosts = traeAccountCandidates(this.realm);
    let lastError: unknown;
    for (const host of hosts) {
      const url = `${host}${TRAE_EXCHANGE_TOKEN_PATH}`;
      try {
        return await this.#exchange(url, refreshToken, userId, signal);
      } catch (err: unknown) {
        lastError = err;
        // A business error (an invalidated refresh token, say) is not a host
        // problem: replaying it on the fallback host just burns the token
        // rotation again. Only a transport failure moves on.
        if (isBusinessError(err)) throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Trae token exchange failed: no host answered");
  }

  /**
   * The {@link OAuthTokenRefresher} entry point.
   *
   * The user id the exchange needs is the account's own id, which the refresh
   * context already carries; requiring the caller to pass it separately would
   * invite a mismatch between the account being refreshed and the one the
   * exchange is addressed to.
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: { readonly account_id?: string },
  ): Promise<OAuthTokenRefreshResult> {
    return this.refreshWithUser(refreshToken, context?.account_id ?? "", signal);
  }

  async #exchange(
    url: string,
    refreshToken: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ClientID: TRAE_CLIENT_ID,
        RefreshToken: refreshToken,
        ClientSecret: TRAE_CLIENT_SECRET,
        UserID: userId,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Trae token exchange failed with HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as TraeExchangeResponse;
    const result = parsed.Result ?? parsed;
    const access = result.Token;
    if (typeof access !== "string" || access.length === 0) {
      // Upstream reports the reason beside the missing token, so surface it
      // rather than a generic failure — an invalidated refresh token is an
      // operator-actionable message.
      const code = parsed.Code ?? "refresh_failed";
      const detail = typeof parsed.Message === "string" ? `: ${parsed.Message}` : "";
      throw new Error(`Trae token exchange rejected (${code})${detail}`);
    }
    const refresh = result.RefreshToken;
    const expiryMs = result.TokenExpireAt;
    return {
      access,
      // Upstream rotates the refresh token, so the new one must be stored or
      // the account cannot be refreshed a second time.
      ...(typeof refresh === "string" && refresh.length > 0 ? { refresh } : {}),
      expiresAt:
        typeof expiryMs === "number" && Number.isFinite(expiryMs)
          ? new Date(expiryMs)
          : new Date(Date.now() + 3600_000),
      ...(typeof result.UserJwt === "string" && result.UserJwt.length > 0
        ? { auth_state: { userJwt: result.UserJwt } }
        : {}),
    };
  }
}

/**
 * True when an error came from upstream rather than the transport.
 *
 * `#exchange` throws a plain `Error` for both, so the distinction has to be
 * made on the message; a business rejection must not be retried on another
 * host, because each attempt rotates the refresh token again.
 */
function isBusinessError(err: unknown): boolean {
  return err instanceof Error && (err.message.includes("rejected") || err.message.includes("HTTP 4"));
}

/** Assembles an import result for an already-complete export. */
function parsedResult(
  parsed: TraeExport,
  access: string,
  refresh: string,
  isStatic: boolean,
): OAuthExchangeResult {
  return {
    access,
    refresh,
    expiresAt:
      parsed.expiresAtMs === undefined ? new Date(Date.now() + 3600_000) : new Date(parsed.expiresAtMs),
    ...(isStatic ? { auth_state: { staticToken: true } } : {}),
    ...(parsed.email === undefined ? {} : { accountLabel: parsed.email }),
  };
}

/** The parts of a Trae export this flow needs. */
interface TraeExport {
  readonly access: string;
  readonly refresh?: string;
  readonly expiresAtMs?: number;
  readonly email?: string;
  readonly userId?: string;
}

/**
 * Reads a pasted credential as a Trae export.
 *
 * Accepts the exporter's own shape (`accessToken`/`refreshToken`) and the bare
 * access token an operator may have copied out of it. Returns `undefined` when
 * neither reading yields a token, so the caller reports a usable message rather
 * than storing an empty credential.
 */
function parseExport(credential: string): TraeExport | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith("{")) return { access: trimmed };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const access = firstString(parsed, ["accessToken", "access_token", "token"]);
  if (access === undefined) return undefined;
  const refresh = firstString(parsed, ["refreshToken", "refresh_token", "refresh"]);
  const expiresAtMs = firstNumber(parsed, ["expiredAt", "expiresAt", "TokenExpireAt", "tokenExpireAt"]);
  const email = firstString(parsed, ["email", "userEmail", "accountLabel"]);
  const userId = firstString(parsed, ["userId", "user_id", "uid", "UserID"]);
  return {
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(email === undefined ? {} : { email }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      // An ISO expiry is what a re-export carries; epoch ms is what the
      // exchange returns, and both appear in the wild.
      const asMs = Date.parse(value);
      if (Number.isFinite(asMs)) return asMs;
    }
  }
  return undefined;
}

/** Client bound to the intl deployment. */
export const traeOAuthClient = new TraeOAuthClient();

/** Client bound to the China deployment. */
export const traeCnOAuthClient = new TraeOAuthClient(globalThis.fetch, "cn");
