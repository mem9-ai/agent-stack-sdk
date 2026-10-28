import {
  usageQuery,
  type UserUsageOptions,
  type UserUsageDetailsOptions,
  type UserUsageSummary,
  type UserUsageDetails,
} from "./usage.js";
import { UserSchedulers } from "./schedulers.js";
import { UserFiles } from "./files.js";
import { OutcomeUnknownError } from "./errors.js";
import {
  HttpClient,
  isApiKey,
  paginationQuery,
  requireCreationKey,
  requireKnownKeys,
  type ListOptions,
} from "./http.js";
import type { RequestOptions } from "./organization.js";
import {
  createSessionForAgent,
  type CreateSessionOptions,
  Session,
  type SessionRecord,
} from "./session.js";
import type { RealtimeModelCatalog } from "./realtime.js";

export interface UserClientOptions {
  baseUrl: string;
  apiKey: string;
}

/** Create/list/unlink return association metadata; owner get/update also include preferences. */
export interface AgentRecord {
  agentId: string;
  organizationId: string;
  ownerUserId: string;
  agentTemplateId: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  additionalInstructions?: string;
}

export interface AgentTemplate {
  agentTemplateId: string;
  displayName: string;
  description: string;
  contentDigest: string;
}

export interface AgentTemplatePage {
  templates: AgentTemplate[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface AgentModelCatalog {
  defaultModel: string;
  models: {
    model: string;
    label: string;
    availability: "available" | "provider_unconfigured";
  }[];
  organizationDefaultModel: string;
  effectiveDefaultModel: string;
  organizationAllowedModels: string[];
  effectiveAllowedModels: string[];
}

export interface CreateAgentInput extends RequestOptions {
  agentTemplateId: string;
  /** Keep the same key and input when recovering an uncertain creation. */
  idempotencyKey: string;
}

export interface UpdateAgentInput {
  /** Applied only to future Sessions. Null or empty text clears the preference. */
  additionalInstructions: string | null;
}

const agentReceipt = (
  value: { agent?: AgentRecord },
  requestId: string,
): AgentRecord => {
  if (typeof value?.agent?.agentId !== "string" || !value.agent.agentId) {
    throw new OutcomeUnknownError(
      "Agent mutation returned no usable Agent; reconcile before retrying",
      { requestId },
    );
  }
  return value.agent;
};

export class Agent {
  readonly #http: HttpClient;
  #record: AgentRecord;

  constructor(http: HttpClient, record: AgentRecord) {
    this.#http = http;
    this.#record = record;
  }

  get id(): string {
    return this.#record.agentId;
  }
  get status(): AgentRecord["status"] {
    return this.#record.status;
  }
  get data(): Readonly<AgentRecord> {
    return this.#record;
  }

  async refresh(options?: RequestOptions): Promise<this> {
    const response = await this.#http.get<{ agent: AgentRecord }>(
      `/api/v1/user/agents/${encodeURIComponent(this.id)}`,
      options,
    );
    this.#record = response.agent;
    return this;
  }

  async update(
    input: UpdateAgentInput,
    options?: RequestOptions,
  ): Promise<this> {
    requireKnownKeys(input, ["additionalInstructions"], "Agent preferences");
    if (
      input.additionalInstructions !== null &&
      typeof input.additionalInstructions !== "string"
    )
      throw new TypeError("Agent preferences require additionalInstructions");
    const result = await this.#http.patchResponse<{ agent: AgentRecord }>(
      `/api/v1/user/agents/${encodeURIComponent(this.id)}`,
      input,
      { ...options, outcomeUnknown: true },
    );
    this.#record = agentReceipt(result.data, result.requestId);
    return this;
  }

  createSession(options: CreateSessionOptions): Promise<Session> {
    return createSessionForAgent(this.#http, this.id, options);
  }
}

export interface SessionPage {
  sessions: Session[];
  hasMore: boolean;
  nextCursor: string | null;
}

export class UserClient {
  readonly #http: HttpClient;
  readonly #files: UserFiles;
  readonly #schedulers: UserSchedulers;

  get schedulers(): UserSchedulers {
    return this.#schedulers;
  }

  get files(): UserFiles {
    return this.#files;
  }

  constructor(options: UserClientOptions) {
    requireKnownKeys(options, ["baseUrl", "apiKey"], "UserClient options");
    if (!isApiKey(options.apiKey, "user"))
      throw new TypeError("UserClient requires a User API Key");
    this.#http = new HttpClient(options);
    this.#files = new UserFiles(this.#http);
    this.#schedulers = new UserSchedulers(this.#http);
  }

  async listAgents(options?: RequestOptions): Promise<Agent[]> {
    const response = await this.#http.get<{ agents: AgentRecord[] }>(
      "/api/v1/user/agents",
      options,
    );
    return response.agents.map((agent) => new Agent(this.#http, agent));
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    requireKnownKeys(
      input,
      ["agentTemplateId", "idempotencyKey", "signal", "requestId"],
      "Agent creation",
    );
    if (
      typeof input.agentTemplateId !== "string" ||
      !input.agentTemplateId.trim()
    )
      throw new TypeError("Agent creation requires a Template ID");
    requireCreationKey(input.idempotencyKey);
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      "/api/v1/user/agents",
      { agentTemplateId: input.agentTemplateId },
      {
        idempotencyKey: input.idempotencyKey,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        idempotent: true,
        outcomeUnknown: true,
      },
    );
    return new Agent(this.#http, agentReceipt(result.data, result.requestId));
  }

  getUsage(options: UserUsageOptions = {}): Promise<UserUsageSummary> {
    return this.#http.get(
      `/api/v1/billing/usage${usageQuery(options, ["period", "from", "to", "tagKey", "tagValue"])}`,
      options,
    );
  }

  getUsageDetails(
    options: UserUsageDetailsOptions = {},
  ): Promise<UserUsageDetails> {
    return this.#http.get(
      `/api/v1/billing/usage/details${usageQuery(options, ["period", "from", "to", "tagKey", "tagValue", "limit"])}`,
      options,
    );
  }

  async getAgent(id: string, options?: RequestOptions): Promise<Agent> {
    const response = await this.#http.get<{ agent: AgentRecord }>(
      `/api/v1/user/agents/${encodeURIComponent(id)}`,
      options,
    );
    return new Agent(this.#http, response.agent);
  }

  listAgentTemplates(options?: ListOptions): Promise<AgentTemplatePage> {
    return this.#http.get(
      `/api/v1/user/agent-templates${paginationQuery(options)}`,
      options,
    );
  }

  listModels(
    options?: RequestOptions & { agentId?: string },
  ): Promise<AgentModelCatalog> {
    const query =
      options?.agentId === undefined
        ? ""
        : `?agentId=${encodeURIComponent(options.agentId)}`;
    return this.#http.get(`/api/v1/agent-models${query}`, options);
  }

  listRealtimeModels(options?: RequestOptions): Promise<RealtimeModelCatalog> {
    return this.#http.get("/api/v1/realtime-models", options);
  }

  async listSessions(options?: ListOptions): Promise<SessionPage> {
    const response = await this.#http.get<{
      sessions: SessionRecord[];
      hasMore: boolean;
      nextCursor: string | null;
    }>(`/api/v1/user/sessions${paginationQuery(options)}`, options);
    return {
      ...response,
      sessions: response.sessions.map(
        (record) => new Session(this.#http, record.sessionId, record),
      ),
    };
  }

  session(id: string): Session {
    return new Session(this.#http, id);
  }
  getSession(id: string, options?: RequestOptions): Promise<Session> {
    return this.session(id).refresh(options);
  }
}
