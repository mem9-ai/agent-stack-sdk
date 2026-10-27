import { OutcomeUnknownError } from "./errors.js";
import { HttpClient } from "./http.js";

export interface OrganizationClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface Organization {
  organizationId: string;
  slug: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EndUser {
  userId: string;
  organizationId: string;
  displayName: string | null;
  externalId: string | null;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface CreateEndUserInput {
  displayName?: string;
  externalId?: string;
}

export interface RequestOptions {
  requestId?: string;
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

const issuedUserApiKey = (
  value: unknown,
  requestId: string,
): IssuedUserApiKey => {
  const result = value as { apiKey?: unknown; token?: unknown };
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.apiKey !== "object" ||
    result.apiKey === null ||
    Array.isArray(result.apiKey) ||
    typeof (result.apiKey as UserApiKey).apiKeyId !== "string" ||
    !(result.apiKey as UserApiKey).apiKeyId ||
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

/** Customer operations authorized by an Organization API Key. */
export class OrganizationClient {
  readonly #http: HttpClient;

  constructor(options: OrganizationClientOptions) {
    if (!options.apiKey.startsWith("ti_org_")) {
      throw new TypeError(
        "OrganizationClient requires an Organization API Key",
      );
    }
    this.#http = new HttpClient(options);
  }

  async getOrganization(options?: RequestOptions): Promise<Organization> {
    const response = await this.#http.get<{ organization: Organization }>(
      "/api/v1/org",
      options,
    );
    return response.organization;
  }

  async createEndUser(
    input: CreateEndUserInput = {},
    options?: RequestOptions,
  ): Promise<EndUser> {
    const result = await this.#http.postResponse<{ user?: EndUser }>(
      "/api/v1/org/users",
      {
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        ...(input.externalId === undefined
          ? {}
          : { externalId: input.externalId }),
      },
      { ...options, outcomeUnknown: true },
    );
    if (
      !result.data?.user ||
      typeof result.data.user.userId !== "string" ||
      !result.data.user.userId
    ) {
      throw new OutcomeUnknownError(
        "End User creation returned no usable User; reconcile by externalId",
        {
          requestId: result.requestId,
        },
      );
    }
    return result.data.user;
  }

  async listEndUsers(options?: RequestOptions): Promise<EndUser[]> {
    const response = await this.#http.get<{ users: EndUser[] }>(
      "/api/v1/org/users",
      options,
    );
    return response.users;
  }

  async getEndUser(userId: string, options?: RequestOptions): Promise<EndUser> {
    const response = await this.#http.get<{ user: EndUser }>(
      `/api/v1/org/users/${encodeURIComponent(userId)}`,
      options,
    );
    return response.user;
  }

  async createUserApiKey(
    userId: string,
    input: { name: string },
    options?: RequestOptions,
  ): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/v1/org/users/${encodeURIComponent(userId)}/api-keys`,
      { name: input.name },
      { ...options, outcomeUnknown: true },
    );
    return issuedUserApiKey(result.data, result.requestId);
  }

  async listUserApiKeys(
    userId: string,
    options?: RequestOptions,
  ): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/v1/org/users/${encodeURIComponent(userId)}/api-keys`,
      options,
    );
    return response.apiKeys;
  }

  async rotateUserApiKey(
    apiKeyId: string,
    options?: RequestOptions,
  ): Promise<IssuedUserApiKey> {
    const result = await this.#http.postResponse<unknown>(
      `/api/v1/org/user-api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
      undefined,
      { ...options, outcomeUnknown: true },
    );
    return issuedUserApiKey(result.data, result.requestId);
  }

  async revokeUserApiKey(
    apiKeyId: string,
    options?: RequestOptions,
  ): Promise<UserApiKey> {
    const response = await this.#http.post<{ apiKey: UserApiKey }>(
      `/api/v1/org/user-api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
      undefined,
      { ...options, idempotent: true, outcomeUnknown: true },
    );
    return response.apiKey;
  }
}
