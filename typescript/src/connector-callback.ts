import { TiDBLinkError } from "./errors.js";
import type { FetchFunction } from "./http.js";

export const CONNECTOR_CALLBACK_ISSUER = "tidb-link/connector-callback/v1";
export const CONNECTOR_CALLBACK_AUDIENCE = "tidb-link/connector";
/** The `params._meta` key of the Call Context on every Connector `tools/call`. */
export const CONNECTOR_CALL_CONTEXT_KEY = "tidb-link/context";

/** A public Ed25519 key that signs Connector callback tokens. */
export interface ConnectorVerificationKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

/** The verified claims of a Connector callback token. */
export interface ConnectorCallbackClaims {
  iss: typeof CONNECTOR_CALLBACK_ISSUER;
  aud: typeof CONNECTOR_CALLBACK_AUDIENCE;
  organizationId: string;
  connectorId: string;
  iat: number;
  exp: number;
}

/**
 * Who a Connector tool call is for, written by the platform from the
 * Session's persisted owner. Model arguments cannot override it.
 */
export interface ConnectorCallContext {
  /** Globally unique; deduplicate side effects by it. */
  callId: string;
  sessionId: string;
  organizationId: string;
  /** The Session owner's End User ID. Map it to your own account. */
  userId: string;
  /** When the platform stops waiting. Abandon the work after it. */
  deadline: string;
  /** Always 1: the platform never retries a call. */
  attempt: 1;
}

/** A Connector callback was refused: bad signature, wrong scope or expired. */
export class ConnectorAuthError extends TiDBLinkError {}

export interface ConnectorKeySetOptions {
  /** Your trusted TiDB Link deployment, for example `https://api.example.com`. */
  baseUrl: string;
  fetch?: FetchFunction;
  /** How long fetched keys are reused. Default 10 minutes. */
  maxAgeMs?: number;
  /** Minimum time between refreshes for an unknown key ID. Default 30 seconds. */
  minRefreshIntervalMs?: number;
}

/**
 * Caches the deployment's public verification keys from
 * `GET /api/v1/connectors/jwks`. Fetch keys only from your trusted deployment
 * URL, never from a URL a token names.
 */
export class ConnectorKeySet {
  readonly #url: URL;
  readonly #fetch: FetchFunction;
  readonly #maxAgeMs: number;
  readonly #minRefreshIntervalMs: number;
  #keys = new Map<string, CryptoKey>();
  #fetchedAt = -Infinity;
  #loading: Promise<void> | undefined;

  constructor(options: ConnectorKeySetOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:")
      throw new TypeError("baseUrl must be an HTTP(S) URL");
    this.#url = new URL("/api/v1/connectors/jwks", base);
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#maxAgeMs = options.maxAgeMs ?? 600_000;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? 30_000;
  }

  /** The key for `kid`, refreshing the cache when it is stale or the key is new. */
  async key(kid: string): Promise<CryptoKey | undefined> {
    const age = Date.now() - this.#fetchedAt;
    if (
      age > this.#maxAgeMs ||
      (!this.#keys.has(kid) && age > this.#minRefreshIntervalMs)
    )
      await this.refresh();
    return this.#keys.get(kid);
  }

  /** Fetch the keys now. Concurrent callers share one request. */
  refresh(): Promise<void> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #load(): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch (cause) {
      throw new TiDBLinkError("Connector verification keys are unreachable", { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TiDBLinkError(
        `Connector verification keys are unavailable (status ${response.status})`,
      );
    }
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body?.keys))
      throw new TiDBLinkError("Connector verification keys are malformed");
    const keys = new Map<string, CryptoKey>();
    for (const key of body.keys as Partial<ConnectorVerificationKey>[]) {
      if (
        key?.kty !== "OKP" ||
        key.crv !== "Ed25519" ||
        key.alg !== "EdDSA" ||
        key.use !== "sig" ||
        typeof key.kid !== "string" ||
        typeof key.x !== "string"
      )
        continue;
      keys.set(
        key.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "OKP", crv: "Ed25519", x: key.x },
          { name: "Ed25519" },
          false,
          ["verify"],
        ),
      );
    }
    this.#keys = keys;
    this.#fetchedAt = Date.now();
  }
}

export interface VerifyConnectorCallbackOptions {
  keys: ConnectorKeySet;
  /** Your Organization; tokens for another are refused. */
  organizationId: string;
  /** This Connector; tokens for another are refused. */
  connectorId: string;
  /** Allowed clock difference with the platform. Default 5 seconds. */
  clockToleranceSec?: number;
  /** Override the current time, in milliseconds since the epoch. */
  now?: number;
}

const base64UrlBytes = (part: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const decodeJson = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not an object");
  return value as Record<string, unknown>;
};

/**
 * Verify the `Authorization` header of a request the platform sends to your
 * HTTP Connector (initialization, tool discovery and tool calls). Returns the
 * claims, or throws ConnectorAuthError. A token may be reused within its
 * scope until it expires, so verification needs no per-request state.
 */
export async function verifyConnectorCallback(
  authorization: string | null | undefined,
  options: VerifyConnectorCallbackOptions,
): Promise<ConnectorCallbackClaims> {
  const refuse = (reason: string): never => {
    throw new ConnectorAuthError(`Connector callback refused: ${reason}`);
  };
  const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    authorization ?? "",
  );
  if (!bearer) return refuse("missing or malformed bearer token");
  const [headerPart, payloadPart, signaturePart] = bearer[1]!.split(".") as [
    string,
    string,
    string,
  ];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(headerPart);
    claims = decodeJson(payloadPart);
  } catch {
    return refuse("undecodable token");
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string")
    return refuse("unsupported algorithm");
  const key = await options.keys.key(header.kid);
  if (!key) return refuse("unknown signing key");
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return refuse("invalid signature");
  const now = (options.now ?? Date.now()) / 1000;
  const tolerance = options.clockToleranceSec ?? 5;
  const { iat, exp } = claims;
  if (
    claims.iss !== CONNECTOR_CALLBACK_ISSUER ||
    claims.aud !== CONNECTOR_CALLBACK_AUDIENCE
  )
    return refuse("wrong issuer or audience");
  if (
    claims.organizationId !== options.organizationId ||
    claims.connectorId !== options.connectorId
  )
    return refuse("issued for another Organization or Connector");
  if (
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    (exp as number) <= (iat as number) ||
    (exp as number) - (iat as number) > 60 ||
    (iat as number) > now + tolerance ||
    (exp as number) <= now - tolerance
  )
    return refuse("expired or not yet valid");
  return claims as unknown as ConnectorCallbackClaims;
}

/**
 * Read the Call Context from a `tools/call` request's `params._meta`. Throws
 * ConnectorAuthError when it is missing, malformed or for another
 * Organization. Initialization and tool discovery carry no Call Context.
 */
export function readConnectorCallContext(
  meta: unknown,
  options: { organizationId: string },
): ConnectorCallContext {
  const context = (meta as Record<string, unknown> | null | undefined)?.[
    CONNECTOR_CALL_CONTEXT_KEY
  ] as Partial<ConnectorCallContext> | undefined;
  const text = (value: unknown) => typeof value === "string" && value.length > 0;
  if (
    !context ||
    !text(context.callId) ||
    !text(context.sessionId) ||
    !text(context.userId) ||
    !text(context.deadline) ||
    !Number.isFinite(Date.parse(context.deadline!)) ||
    context.attempt !== 1
  )
    throw new ConnectorAuthError("Connector call has no valid Call Context");
  if (context.organizationId !== options.organizationId)
    throw new ConnectorAuthError("Connector call is for another Organization");
  return context as ConnectorCallContext;
}
