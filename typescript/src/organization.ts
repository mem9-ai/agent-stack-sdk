import {
  usageQuery,
  userUsagePath,
  type OrganizationUserUsageOptions,
  type OrganizationUserUsageDetailsOptions,
  type OrganizationUserUsageSummary,
  type OrganizationUserUsageDetails,
} from "./usage.js";
import { EndUserClient } from "./user.js";
import { Templates } from "./templates.js";
import { Skills } from "./skills.js";
import { Connectors } from "./connectors.js";
import { OutcomeUnknownError } from "./errors.js";
import {
  HttpClient,
  type FetchFunction,
  isOrganizationApiKey,
  requireKnownKeys,
  requestOptions,
} from "./http.js";

export interface OrganizationClientOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * Replaces the global `fetch` for every request the client makes, including
   * event streams and file transfers. Use it for proxies, custom agents,
   * instrumentation or tests. Defaults to `globalThis.fetch`.
   */
  fetch?: FetchFunction;
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
  /**
   * Your application's identity for this End User. Creation with an
   * externalId is idempotent: when an End User of this Organization already
   * has exactly this externalId, the service returns it unchanged and ignores
   * the other fields. Without one, every call creates a new End User.
   */
  externalId?: string;
}

export interface RequestOptions {
  requestId?: string;
  signal?: AbortSignal;
}

/** Customer operations authorized by an Organization API Key. */
export class OrganizationClient {
  readonly #http: HttpClient;
  readonly #templates: Templates;
  readonly #skills: Skills;
  readonly #connectors: Connectors;

  /** Organization Agent Templates. */
  get templates(): Templates {
    return this.#templates;
  }

  /** Organization Skills that Templates reference. */
  get skills(): Skills {
    return this.#skills;
  }

  /** Organization Connectors: MCP tool servers that Agents call. */
  get connectors(): Connectors {
    return this.#connectors;
  }

  constructor(options: OrganizationClientOptions) {
    requireKnownKeys(
      options,
      ["baseUrl", "apiKey", "fetch"],
      "OrganizationClient options",
    );
    if (!isOrganizationApiKey(options.apiKey)) {
      throw new TypeError(
        "OrganizationClient requires an Organization API Key",
      );
    }
    this.#http = new HttpClient(options);
    this.#templates = new Templates(this.#http);
    this.#skills = new Skills(this.#http);
    this.#connectors = new Connectors(this.#http);
  }

  /** Select the End User who owns the resources; the Organization API Key remains the caller. */
  user(userId: string): EndUserClient {
    return new EndUserClient(this.#http.forUser(userId));
  }

  getUserUsage(
    userId: string,
    options: OrganizationUserUsageOptions,
  ): Promise<OrganizationUserUsageSummary> {
    const path = userUsagePath(userId, options);
    return this.#http.get(
      `${path}${usageQuery(options, ["from", "to", "interval", "templateId", "tagKey", "tagValue"])}`,
      options,
    );
  }

  getUserUsageDetails(
    userId: string,
    options: OrganizationUserUsageDetailsOptions,
  ): Promise<OrganizationUserUsageDetails> {
    const path = userUsagePath(userId, options);
    return this.#http.get(
      `${path}/details${usageQuery(options, ["from", "to", "kind", "limit", "cursor", "templateId", "tagKey", "tagValue"])}`,
      options,
    );
  }

  async getOrganization(options?: RequestOptions): Promise<Organization> {
    const response = await this.#http.get<{ organization: Organization }>(
      "",
      requestOptions(options),
    );
    return response.organization;
  }

  /**
   * Create an End User, or return the existing one with the same externalId.
   * Calls with an externalId are retried automatically and are safe to repeat
   * after an uncertain outcome. An externalId that only differs by case or
   * accents from an existing one is refused with a ConflictError.
   */
  async createEndUser(
    input: CreateEndUserInput = {},
    options?: RequestOptions,
  ): Promise<EndUser> {
    requireKnownKeys(input, ["displayName", "externalId"], "End User input");
    const result = await this.#http.postResponse<{ user?: EndUser }>(
      "/users",
      {
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        ...(input.externalId === undefined
          ? {}
          : { externalId: input.externalId }),
      },
      {
        ...requestOptions(options),
        outcomeUnknown: true,
        idempotent: input.externalId !== undefined,
      },
    );
    if (
      !result.data?.user ||
      typeof result.data.user.userId !== "string" ||
      !result.data.user.userId
    ) {
      throw new OutcomeUnknownError(
        "End User creation returned no usable User; repeat it with the same externalId",
        {
          requestId: result.requestId,
        },
      );
    }
    return result.data.user;
  }

  async listEndUsers(options?: RequestOptions): Promise<EndUser[]> {
    const response = await this.#http.get<{ users: EndUser[] }>(
      "/users",
      requestOptions(options),
    );
    return response.users;
  }

  async getEndUser(userId: string, options?: RequestOptions): Promise<EndUser> {
    const response = await this.#http.get<{ user: EndUser }>(
      `/users/${encodeURIComponent(userId)}`,
      requestOptions(options),
    );
    return response.user;
  }
}
