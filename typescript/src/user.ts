import { HttpClient, isApiKey, requireKnownKeys } from "./http.js";
import { createSessionForAgent, type BillingTag, type SessionRecord, Session } from "./session.js";

export interface UserClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface AgentRecord {
  agentId: string;
  organizationId: string;
  ownerUserId: string;
  agentTemplateId: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplate {
  agentTemplateId: string;
  displayName: string;
  description: string;
  latestPublishedVersion: number;
}

export interface AgentTemplatePage {
  templates: AgentTemplate[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CreateAgentInput {
  agentTemplateId: string;
  signal?: AbortSignal;
}

export class Agent {
  readonly #http: HttpClient;
  #record: AgentRecord;

  constructor(http: HttpClient, record: AgentRecord) {
    this.#http = http;
    this.#record = record;
  }

  get id(): string { return this.#record.agentId; }
  get data(): Readonly<AgentRecord> { return this.#record; }

  async refresh(options?: { signal?: AbortSignal }): Promise<this> {
    const response = await this.#http.get<{ agent: AgentRecord }>(`/api/v1/agents/${encodeURIComponent(this.id)}`, options);
    this.#record = response.agent;
    return this;
  }

  async unlink(options?: { signal?: AbortSignal }): Promise<void> {
    await this.#http.delete(`/api/v1/agents/${encodeURIComponent(this.id)}`, options);
  }

  async revealMemoryKey(options?: { signal?: AbortSignal }): Promise<string> {
    const response = await this.#http.get<{ mem9Key: string }>(`/api/v1/agents/${encodeURIComponent(this.id)}/memory/mem9/key`, options);
    return response.mem9Key;
  }

  async replaceMemoryKey(mem9Key: string, options?: { signal?: AbortSignal }): Promise<this> {
    await this.#http.put(`/api/v1/agents/${encodeURIComponent(this.id)}/memory/mem9/key`, { mem9Key }, { outcomeUnknown: true, ...options });
    return this;
  }

  createSession(options?: { billingTag?: BillingTag | null; signal?: AbortSignal }): Promise<Session> {
    return createSessionForAgent(this.#http, this.id, options);
  }
}

export class UserClient {
  readonly #http: HttpClient;

  constructor(options: UserClientOptions) {
    requireKnownKeys(options, ["baseUrl", "apiKey"], "UserClient options");
    if (!isApiKey(options.apiKey, "user")) throw new TypeError("UserClient requires a User API Key");
    this.#http = new HttpClient(options);
  }

  async listAgents(options?: { signal?: AbortSignal }): Promise<Agent[]> {
    const response = await this.#http.get<{ agents: AgentRecord[] }>("/api/v1/agents", options);
    return response.agents.map(record => new Agent(this.#http, record));
  }

  validateMemoryKey(mem9Key: string, options?: { signal?: AbortSignal }): Promise<{ valid: true }> {
    return this.#http.post("/api/v1/agents/memory/mem9/key-validations", { mem9Key }, { idempotent: true, ...options });
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    requireKnownKeys(input, ["agentTemplateId", "signal"], "Agent creation");
    if (typeof input.agentTemplateId !== "string" || !input.agentTemplateId.trim()) throw new TypeError("Agent creation requires an explicit published Template ID");
    const response = await this.#http.post<{ agent: AgentRecord }>("/api/v1/agents", { agentTemplateId: input.agentTemplateId }, { idempotent: true, ...input.signal ? { signal: input.signal } : {} });
    return new Agent(this.#http, response.agent);
  }

  async getAgent(id: string, options?: { signal?: AbortSignal }): Promise<Agent> {
    const response = await this.#http.get<{ agent: AgentRecord }>(`/api/v1/agents/${encodeURIComponent(id)}`, options);
    return new Agent(this.#http, response.agent);
  }

  listAgentTemplates(options?: { limit?: number; cursor?: string; signal?: AbortSignal }): Promise<AgentTemplatePage> {
    const query = new URLSearchParams();
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    return this.#http.get(`/api/v1/agent-templates${query.size ? `?${query}` : ""}`, options);
  }

  async listSessions(options?: { signal?: AbortSignal }): Promise<Session[]> {
    const response = await this.#http.get<{ sessions: SessionRecord[] }>("/api/v1/sessions", options);
    return response.sessions.map(record => new Session(this.#http, record.sessionId, record));
  }

  session(id: string): Session { return new Session(this.#http, id); }
  getSession(id: string, options?: { signal?: AbortSignal }): Promise<Session> { return this.session(id).refresh(options); }
}
