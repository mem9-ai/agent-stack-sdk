import { OutcomeUnknownError } from "./errors.js";
import { HttpClient, isApiKey, requireKnownKeys } from "./http.js";

export interface OrganizationClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface UserApiKey {
  apiKeyId: string;
  organizationId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  createdByUserId: string | null;
  createdByOrganizationApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedUserApiKey {
  apiKey: UserApiKey;
  /** Available only in the successful create or rotate response. */
  token: string;
}

const issuedUserApiKey = (value: unknown, requestId: string): IssuedUserApiKey => {
  const result = value as { apiKey?: unknown; token?: unknown };
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.apiKey !== "object" ||
    result.apiKey === null ||
    Array.isArray(result.apiKey) ||
    !isApiKey(result.token, "user")
  ) {
    throw new OutcomeUnknownError(
      "TiDB Link accepted the credential request but returned an unusable one-time credential",
      { requestId },
    );
  }
  return result as IssuedUserApiKey;
};

export class ServiceUser {
  readonly #http: HttpClient;
  readonly id: string;

  constructor(http: HttpClient, id: string) {
    if (!id) throw new TypeError("Service User id is required");
    this.#http = http;
    this.id = id;
  }

  async listApiKeys(options?: { signal?: AbortSignal }): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/admin/org/users/${encodeURIComponent(this.id)}/api-keys`,
      options,
    );
    return response.apiKeys;
  }

  async createApiKey(input: { name: string; signal?: AbortSignal }): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/admin/org/users/${encodeURIComponent(this.id)}/api-keys`,
      { name: input.name },
      { ...(input.signal ? { signal: input.signal } : {}), outcomeUnknown: true },
    );
    return issuedUserApiKey(result.data, result.requestId);
  }

  async rotateApiKey(
    apiKeyId: string,
    options?: { signal?: AbortSignal },
  ): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/admin/org/user-api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
      undefined,
      { ...(options?.signal ? { signal: options.signal } : {}), outcomeUnknown: true },
    );
    return issuedUserApiKey(result.data, result.requestId);
  }

  async revokeApiKey(
    apiKeyId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserApiKey> {
    const response = await this.#http.post<{ apiKey: UserApiKey }>(
      `/api/admin/org/user-api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
      undefined,
      { ...(options?.signal ? { signal: options.signal } : {}), idempotent: true },
    );
    return response.apiKey;
  }

  async revokeAllApiKeys(options?: { signal?: AbortSignal }): Promise<UserApiKey[]> {
    const active = (await this.listApiKeys(options)).filter((apiKey) => apiKey.status === "active");
    return Promise.all(active.map((apiKey) => this.revokeApiKey(apiKey.apiKeyId, options)));
  }
}

export class OrganizationClient {
  readonly #http: HttpClient;

  constructor(options: OrganizationClientOptions) {
    requireKnownKeys(options, ["baseUrl", "apiKey"], "OrganizationClient options");
    if (!isApiKey(options.apiKey, "org")) {
      throw new TypeError("OrganizationClient requires an Organization API Key");
    }
    this.#http = new HttpClient(options);
  }

  serviceUser(id: string): ServiceUser {
    return new ServiceUser(this.#http, id);
  }
}
