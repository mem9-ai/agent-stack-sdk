import { OutcomeUnknownError } from "./errors.js";
import { HttpClient, isApiKey, requireKnownKeys } from "./http.js";

export interface OrganizationClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface OrganizationRecord {
  organizationId: string;
  slug: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessUserRecord {
  userId: string;
  organizationId: string;
  displayName: string | null;
  externalId: string | null;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface CreateBusinessUserInput {
  displayName?: string;
  externalId?: string;
  signal?: AbortSignal;
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

export class BusinessUser {
  readonly #http: HttpClient;
  readonly id: string;
  readonly data: Readonly<BusinessUserRecord> | undefined;

  constructor(http: HttpClient, id: string, record?: BusinessUserRecord) {
    if (!id) throw new TypeError("Business User id is required");
    this.#http = http;
    this.id = id;
    this.data = record;
  }

  async listApiKeys(options?: { signal?: AbortSignal }): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/v1/organization/users/${encodeURIComponent(this.id)}/api-keys`,
      options,
    );
    return response.apiKeys;
  }

  async createApiKey(input: { name: string; signal?: AbortSignal }): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/v1/organization/users/${encodeURIComponent(this.id)}/api-keys`,
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
      `/api/v1/organization/user-api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
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
      `/api/v1/organization/user-api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
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

  async getOrganization(options?: { signal?: AbortSignal }): Promise<OrganizationRecord> {
    const response = await this.#http.get<{ organization: OrganizationRecord }>("/api/v1/organization", options);
    return response.organization;
  }

  async createBusinessUser(input: CreateBusinessUserInput = {}): Promise<BusinessUser> {
    requireKnownKeys(input, ["displayName", "externalId", "signal"], "Business User creation");
    const response = await this.#http.post<{ user: BusinessUserRecord }>(
      "/api/v1/organization/users",
      { ...(input.displayName === undefined ? {} : { displayName: input.displayName }), ...(input.externalId === undefined ? {} : { externalId: input.externalId }) },
      { outcomeUnknown: true, ...(input.signal ? { signal: input.signal } : {}) },
    );
    return new BusinessUser(this.#http, response.user.userId, response.user);
  }

  async listBusinessUsers(options?: { signal?: AbortSignal }): Promise<BusinessUser[]> {
    const response = await this.#http.get<{ users: BusinessUserRecord[] }>("/api/v1/organization/users", options);
    return response.users.map(record => new BusinessUser(this.#http, record.userId, record));
  }

  async getBusinessUser(id: string, options?: { signal?: AbortSignal }): Promise<BusinessUser> {
    const response = await this.#http.get<{ user: BusinessUserRecord }>(`/api/v1/organization/users/${encodeURIComponent(id)}`, options);
    return new BusinessUser(this.#http, response.user.userId, response.user);
  }

  businessUser(id: string): BusinessUser {
    return new BusinessUser(this.#http, id);
  }
}
