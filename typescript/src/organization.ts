import {
  usageQuery,
  userUsagePath,
  type OrganizationUserUsageOptions,
  type OrganizationUserUsageDetailsOptions,
  type OrganizationUserUsageSummary,
  type OrganizationUserUsageDetails,
} from "./usage.js";
import { EndUserClient, type AgentRecord } from "./user.js";
import { OutcomeUnknownError } from "./errors.js";
import {
  HttpClient,
  isOrganizationApiKey,
  requireKnownKeys,
  requestOptions,
} from "./http.js";

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

/** Customer operations authorized by an Organization API Key. */
export class OrganizationClient {
  readonly #http: HttpClient;

  constructor(options: OrganizationClientOptions) {
    requireKnownKeys(
      options,
      ["baseUrl", "apiKey"],
      "OrganizationClient options",
    );
    if (!isOrganizationApiKey(options.apiKey)) {
      throw new TypeError(
        "OrganizationClient requires an Organization API Key",
      );
    }
    this.#http = new HttpClient(options);
  }

  /** Select the End User who owns the resources; the Organization API Key remains the caller. */
  user(userId: string): EndUserClient {
    return new EndUserClient(this.#http.forUser(userId));
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
}
