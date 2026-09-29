import { HttpClient, requireEtag, requireKnownKeys } from "./http.js";
import { createSessionForAgent, type BillingTag, Session } from "./session.js";

export interface UserClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface EnabledAgentCapability {
  enabled: boolean;
}

export interface McpServerReference {
  serverId: string;
}

export interface AgentConfigInput {
  memory?: EnabledAgentCapability;
  sessionRecall?: EnabledAgentCapability;
  generatedMedia?: EnabledAgentCapability;
  tools?: { mcp?: McpServerReference[] };
}

export interface AgentConfigPatch extends AgentConfigInput {
  sandboxProfile?: string;
}

export interface PublicAgentConfig {
  memory: {
    enabled: boolean;
    provider: "mem9";
    mem9: {
      hasKey: boolean;
      ownershipState:
        | "admin_not_configured"
        | "not_provisioned"
        | "pending"
        | "claimed"
        | "rejected"
        | "outcome_unknown";
    };
  };
  sessionRecall: EnabledAgentCapability;
  generatedMedia: EnabledAgentCapability;
  tools?: { mcp: McpServerReference[] };
}

export interface AgentTemplateProvenance {
  agentTemplateId: string;
  name: string | null;
  status: "active" | "archived" | "unavailable";
}

export interface AgentRecord {
  agentId: string;
  name: string;
  sandboxProfile: string;
  agentTemplateId: string | null;
  agentTemplate: AgentTemplateProvenance | null;
  config: PublicAgentConfig;
  configVersion: number;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplate {
  agentTemplateId: string;
  organizationId: string;
  name: string;
  sandboxProfile: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
}

export type MemoryCredentialInput =
  | { mode: "provision" }
  | { mode: "use_existing"; mem9Key: string };

export interface CreateAgentInput {
  name?: string;
  agentTemplateId?: string | null;
  config?: AgentConfigInput;
  memoryCredential?: MemoryCredentialInput;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const validateAgentConfig = (config: AgentConfigInput | AgentConfigPatch, patch: boolean): void => {
  requireKnownKeys(
    config,
    ["memory", "sessionRecall", "generatedMedia", "tools", ...(patch ? ["sandboxProfile"] : [])],
    "Agent config",
  );
  for (const [name, capability] of [
    ["memory", config.memory],
    ["sessionRecall", config.sessionRecall],
    ["generatedMedia", config.generatedMedia],
  ] as const) {
    if (capability === undefined) continue;
    requireKnownKeys(capability, ["enabled"], `Agent config.${name}`);
    if (typeof capability.enabled !== "boolean") {
      throw new TypeError(`Agent config.${name}.enabled must be a boolean`);
    }
  }
  if (config.tools === undefined) return;
  requireKnownKeys(config.tools, ["mcp"], "Agent config.tools");
  if (config.tools.mcp === undefined) return;
  if (!Array.isArray(config.tools.mcp)) throw new TypeError("Agent config.tools.mcp must be an array");
  for (const server of config.tools.mcp) {
    requireKnownKeys(server, ["serverId"], "Agent config.tools.mcp entry");
    if (typeof server.serverId !== "string") {
      throw new TypeError("Agent config.tools.mcp entry.serverId must be a string");
    }
  }
};

export class Agent {
  readonly #http: HttpClient;
  #etag: string | undefined;
  #record: AgentRecord;

  constructor(http: HttpClient, record: AgentRecord, etag?: string) {
    this.#http = http;
    this.#record = record;
    this.#etag = etag;
  }

  get id(): string {
    return this.#record.agentId;
  }

  get name(): string {
    return this.#record.name;
  }

  get config(): Readonly<PublicAgentConfig> {
    return this.#record.config;
  }

  get status(): AgentRecord["status"] {
    return this.#record.status;
  }

  get data(): Readonly<AgentRecord> {
    return this.#record;
  }

  async refresh(options?: { signal?: AbortSignal }): Promise<this> {
    const result = await this.#http.getResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}`,
      options,
    );
    this.#record = result.data.agent;
    this.#etag = requireEtag(result);
    return this;
  }

  async rename(name: string, options?: { signal?: AbortSignal }): Promise<this> {
    const etag = await this.#currentEtag(options);
    const result = await this.#http.patchResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}/name`,
      { name },
      { ifMatch: etag, outcomeUnknown: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    this.#record = result.data.agent;
    this.#etag = requireEtag(result);
    return this;
  }

  async configure(
    config: AgentConfigPatch,
    options?: { signal?: AbortSignal },
  ): Promise<this> {
    validateAgentConfig(config, true);
    const etag = await this.#currentEtag(options);
    const result = await this.#http.patchResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}/config`,
      config,
      { ifMatch: etag, outcomeUnknown: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    this.#record = result.data.agent;
    this.#etag = requireEtag(result);
    return this;
  }

  async revealMemoryKey(options?: { signal?: AbortSignal }): Promise<string> {
    const response = await this.#http.get<{ mem9Key: string }>(
      `/api/agents/${encodeURIComponent(this.id)}/memory/mem9/key`,
      options,
    );
    return response.mem9Key;
  }

  async replaceMemoryKey(
    mem9Key: string,
    options?: { signal?: AbortSignal },
  ): Promise<this> {
    const response = await this.#http.put<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}/memory/mem9/key`,
      { mem9Key },
      { outcomeUnknown: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    this.#record = response.agent;
    this.#etag = undefined;
    return this;
  }

  async makeDefault(options?: { signal?: AbortSignal }): Promise<this> {
    await this.#http.put(
      "/api/agents/default",
      { agentId: this.id },
      { outcomeUnknown: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    return this;
  }

  async archive(options?: { signal?: AbortSignal }): Promise<void> {
    const etag = await this.#currentEtag(options);
    await this.#http.postResponse(
      `/api/agents/${encodeURIComponent(this.id)}/archive`,
      undefined,
      { ifMatch: etag, outcomeUnknown: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    this.#record = { ...this.#record, status: "archived" };
    this.#etag = undefined;
  }

  createSession(options?: {
    billingTag?: BillingTag | null;
    signal?: AbortSignal;
  }): Promise<Session> {
    return createSessionForAgent(this.#http, this.id, options);
  }

  async #currentEtag(options?: { signal?: AbortSignal }): Promise<string> {
    if (!this.#etag) await this.refresh(options);
    return this.#etag as string;
  }
}

export class UserClient {
  readonly #http: HttpClient;

  constructor(options: UserClientOptions) {
    requireKnownKeys(options, ["baseUrl", "apiKey"], "UserClient options");
    if (!options.apiKey.startsWith("ag9_uak_")) {
      throw new TypeError("UserClient requires a User API Key");
    }
    this.#http = new HttpClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async listAgents(options?: { signal?: AbortSignal }): Promise<Agent[]> {
    const response = await this.#http.get<{ agents: AgentRecord[] }>("/api/agents", options);
    return response.agents.map((agent) => new Agent(this.#http, agent));
  }

  validateMemoryKey(
    mem9Key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ valid: true }> {
    return this.#http.post(
      "/api/agents/memory/mem9/key-validations",
      { mem9Key },
      { idempotent: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
  }

  async createAgent(input: CreateAgentInput = {}): Promise<Agent> {
    requireKnownKeys(
      input,
      ["name", "agentTemplateId", "config", "memoryCredential", "idempotencyKey", "signal"],
      "Agent creation",
    );
    if (input.config !== undefined) validateAgentConfig(input.config, false);
    if (input.memoryCredential !== undefined) {
      requireKnownKeys(input.memoryCredential, ["mode", "mem9Key"], "Memory credential");
      if (input.memoryCredential.mode === "provision") {
        requireKnownKeys(input.memoryCredential, ["mode"], "Memory credential");
      } else if (
        input.memoryCredential.mode !== "use_existing" ||
        typeof input.memoryCredential.mem9Key !== "string"
      ) {
        throw new TypeError("Memory credential mode is not supported");
      }
    }
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      "/api/agents",
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.agentTemplateId === undefined
          ? {}
          : { agentTemplateId: input.agentTemplateId }),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.memoryCredential === undefined
          ? {}
          : { memoryCredential: input.memoryCredential }),
      },
      {
        idempotencyKey,
        idempotent: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return new Agent(this.#http, result.data.agent, requireEtag(result));
  }

  async getAgent(id: string, options?: { signal?: AbortSignal }): Promise<Agent> {
    const result = await this.#http.getResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(id)}`,
      options,
    );
    return new Agent(this.#http, result.data.agent, requireEtag(result));
  }

  async getOrCreateDefaultAgent(options?: { signal?: AbortSignal }): Promise<Agent> {
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      "/api/agents/default/ensure",
      undefined,
      { idempotent: true, ...(options?.signal ? { signal: options.signal } : {}) },
    );
    return new Agent(this.#http, result.data.agent, requireEtag(result));
  }

  async listAgentTemplates(options?: { signal?: AbortSignal }): Promise<AgentTemplate[]> {
    const response = await this.#http.get<{ agentTemplates: AgentTemplate[] }>(
      "/api/console/model",
      options,
    );
    return response.agentTemplates;
  }

  session(id: string): Session {
    return new Session(this.#http, id);
  }

  getSession(id: string, options?: { signal?: AbortSignal }): Promise<Session> {
    return this.session(id).refresh(options);
  }
}
