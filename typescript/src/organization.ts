import {
  usageQuery,
  userUsagePath,
  type OrganizationUserUsageOptions,
  type OrganizationUserUsageDetailsOptions,
  type OrganizationUserUsageSummary,
  type OrganizationUserUsageDetails,
} from "./usage.js";
import type { AgentRecord } from "./user.js";
import { OutcomeUnknownError } from "./errors.js";
import { HttpClient, isApiKey, requireKnownKeys } from "./http.js";

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
    !isApiKey(result.token, "user")
  ) {
    throw new OutcomeUnknownError(
      "TiDB Link accepted the credential request but omitted the one-time credential",
      { requestId },
    );
  }
  return result as IssuedUserApiKey;
};

const requestOptions = (options: RequestOptions = {}): RequestOptions => {
  requireKnownKeys(options, ["requestId", "signal"], "Request options");
  return options;
};

/** Customer operations authorized by an Organization API Key. */
export class OrganizationClient {
  readonly #http: HttpClient;

  constructor(options: OrganizationClientOptions) {
    requireKnownKeys(
      options,
      ["baseUrl", "apiKey"],
      "OrganizationClient options",
    );
    if (!isApiKey(options.apiKey, "org")) {
      throw new TypeError(
        "OrganizationClient requires an Organization API Key",
      );
    }
    this.#http = new HttpClient(options);
  }

  async unlinkAgent(
    userId: string,
    agentId: string,
    options?: RequestOptions,
  ): Promise<AgentRecord> {
    const result = await this.#http.deleteResponse<{ agent: AgentRecord }>(
      `/api/v1/org/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`,
      { ...requestOptions(options), outcomeUnknown: true },
    );
    if (
      typeof result.data?.agent?.agentId !== "string" ||
      !result.data.agent.agentId
    )
      throw new OutcomeUnknownError(
        "Agent unlink returned no usable receipt; reconcile the association",
        { requestId: result.requestId },
      );
    return result.data.agent;
  }

  getUserUsage(
    userId: string,
    options: OrganizationUserUsageOptions,
  ): Promise<OrganizationUserUsageSummary> {
    const path = userUsagePath(userId, options);
    return this.#http.get(
      `${path}${usageQuery(options, ["from", "to", "interval", "tagKey", "tagValue"])}`,
      options,
    );
  }

  getUserUsageDetails(
    userId: string,
    options: OrganizationUserUsageDetailsOptions,
  ): Promise<OrganizationUserUsageDetails> {
    const path = userUsagePath(userId, options);
    return this.#http.get(
      `${path}/details${usageQuery(options, ["from", "to", "kind", "limit", "cursor", "tagKey", "tagValue"])}`,
      options,
    );
  }

  async getOrganization(options?: RequestOptions): Promise<Organization> {
    const response = await this.#http.get<{ organization: Organization }>(
      "/api/v1/org",
      requestOptions(options),
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
      { ...requestOptions(options), outcomeUnknown: true },
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
      requestOptions(options),
    );
    return response.users;
  }

  async getEndUser(userId: string, options?: RequestOptions): Promise<EndUser> {
    const response = await this.#http.get<{ user: EndUser }>(
      `/api/v1/org/users/${encodeURIComponent(userId)}`,
      requestOptions(options),
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
      { ...requestOptions(options), outcomeUnknown: true },
    );
    return issuedUserApiKey(result.data, result.requestId);
  }

  async listUserApiKeys(
    userId: string,
    options?: RequestOptions,
  ): Promise<UserApiKey[]> {
    const response = await this.#http.get<{ apiKeys: UserApiKey[] }>(
      `/api/v1/org/users/${encodeURIComponent(userId)}/api-keys`,
      requestOptions(options),
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
      { ...requestOptions(options), outcomeUnknown: true },
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
      { ...requestOptions(options), outcomeUnknown: true },
    );
    return response.apiKey;
  }
}
