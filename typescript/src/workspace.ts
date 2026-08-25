import { OutcomeUnknownError } from "./errors.js";
import { HttpClient } from "./http.js";

export interface WorkspaceClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface UserApiKey {
  apiKeyId: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  createdByUserId: string | null;
  createdByWorkspaceApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ServiceUserRecord {
  userId: string;
  organizationId: string;
  kind: "service";
  orgRole: string;
  serviceTier: string;
  serviceTierUpdatedAt: string;
  email: null;
  displayName: string | null;
  createdAt: string;
}

export interface WorkspaceMembership {
  userId: string;
  workspaceId: string;
  role: string;
  status: string;
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
    typeof result.token !== "string" ||
    result.token.length === 0
  ) {
    throw new OutcomeUnknownError(
      "Agent Service accepted the credential request but omitted the one-time credential",
      { requestId },
    );
  }
  return result as IssuedUserApiKey;
};

export class ServiceUser {
  readonly #http: HttpClient;
  readonly id: string;
  readonly membership: WorkspaceMembership | undefined;
  readonly user: ServiceUserRecord | undefined;

  constructor(
    http: HttpClient,
    id: string,
    user?: ServiceUserRecord,
    membership?: WorkspaceMembership,
  ) {
    if (!id) throw new TypeError("Service User id is required");
    this.#http = http;
    this.id = id;
    this.user = user;
    this.membership = membership;
  }

  async listApiKeys(options?: { signal?: AbortSignal }): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/admin/users/${encodeURIComponent(this.id)}/api-keys`,
      options,
    );
    return response.apiKeys;
  }

  async createApiKey(input: { name: string; signal?: AbortSignal }): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/admin/users/${encodeURIComponent(this.id)}/api-keys`,
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
      `/api/admin/user-api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
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
      `/api/admin/user-api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
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

export class WorkspaceClient {
  readonly #http: HttpClient;

  constructor(options: WorkspaceClientOptions) {
    if (!options.apiKey.startsWith("ag9_wak.")) {
      throw new TypeError("WorkspaceClient requires a Workspace API Key");
    }
    this.#http = new HttpClient(options);
  }

  serviceUser(id: string): ServiceUser {
    return new ServiceUser(this.#http, id);
  }

  async createServiceUser(input: {
    displayName?: string;
    requestId?: string;
    signal?: AbortSignal;
  } = {}): Promise<ServiceUser> {
    const response = await this.#http.post<{
      user: ServiceUserRecord;
      membership: WorkspaceMembership;
    }>(
      "/api/admin/users",
      input.displayName === undefined ? {} : { displayName: input.displayName },
      {
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.signal ? { signal: input.signal } : {}),
        outcomeUnknown: true,
      },
    );
    return new ServiceUser(this.#http, response.user.userId, response.user, response.membership);
  }
}
