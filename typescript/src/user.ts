import { HttpClient, requireEtag } from "./http.js";
import { createSessionForAgent, Session } from "./session.js";

export interface UserClientOptions {
  baseUrl: string;
  apiKey: string;
  projectId: string;
}

export interface ProjectDiscoveryOptions {
  baseUrl: string;
  apiKey: string;
}

export interface ProjectRecord {
  projectId: string;
  workspaceId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const listProjects = async (
  options: ProjectDiscoveryOptions,
  request?: { signal?: AbortSignal },
): Promise<ProjectRecord[]> => {
  if (
    !options.apiKey.startsWith("ag9_uak_") &&
    !options.apiKey.startsWith("ag9_uak.") &&
    !options.apiKey.startsWith("ag9_wak.")
  ) {
    throw new TypeError("listProjects requires a User or Workspace API Key");
  }
  const response = await new HttpClient(options).get<{ projects: ProjectRecord[] }>(
    "/api/console/projects",
    request,
  );
  return response.projects;
};

export type AgentRuntimeConfigInput =
  | { backend: "pi" }
  | {
      backend: "codex";
      authId: string;
      modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
    };

export type PublicAgentRuntimeConfig =
  | { backend: "pi" }
  | {
      backend: "codex";
      authId?: string;
      modelReasoningEffort: "low" | "medium" | "high" | "xhigh";
    };

export interface EnabledAgentCapability {
  enabled: boolean;
}

export interface PublicAgentLarkConfig {
  apiBaseUrl: "https://open.feishu.cn" | "https://open.larksuite.com";
  appId: string;
  hasAppSecret: boolean;
  toolNames?: string[];
  coverageItemIds?: string[];
  enabled: boolean;
  hasLarkAuth: boolean;
  status: "configured" | "authorized" | "needs_reauth" | "error";
}

export interface ManagedToolReference {
  name: string;
  version: number;
  packageDigest: string;
}

export interface AgentConfigInput {
  runtime?: AgentRuntimeConfigInput;
  delegation?: EnabledAgentCapability;
  sessionRecall?: EnabledAgentCapability;
  knowledgeBase?: EnabledAgentCapability;
  generatedMedia?: EnabledAgentCapability;
}

export interface AgentConfigPatch extends AgentConfigInput {
  sandboxProfile?: string;
}

export interface PublicAgentConfig {
  runtime: PublicAgentRuntimeConfig;
  delegation: EnabledAgentCapability;
  lark?: PublicAgentLarkConfig;
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
  knowledgeBase: EnabledAgentCapability;
  generatedMedia: EnabledAgentCapability;
  tools?: { managed: ManagedToolReference[]; mcp: { serverId: string }[] };
}

export interface AgentTemplateProvenance {
  agentTemplateId: string;
  name: string | null;
  status: string;
}

export interface AgentRecord {
  agentId: string;
  workspaceId: string;
  name: string;
  sandboxProfile: string;
  /** @deprecated Compatibility projection from Agent Service. */
  e2bTemplate: string;
  /** Compatibility-only; Session owns the mutable model. */
  model: string;
  modelPolicyStatus: string;
  agentTemplateId: string | null;
  /** @deprecated Use agentTemplateId. */
  agentDefinitionId: string | null;
  agentTemplate: AgentTemplateProvenance | null;
  config: PublicAgentConfig;
  configVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplate {
  agentTemplateId: string;
  /** @deprecated Use agentTemplateId. */
  agentDefinitionId: string;
  workspaceId: string;
  name: string;
  sandboxProfile: string;
  /** @deprecated Use sandboxProfile. */
  e2bTemplate: string;
  model: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name?: string;
  agentTemplateId?: string;
  config?: AgentConfigInput;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

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

  get status(): string {
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

  createSession(options?: { signal?: AbortSignal }): Promise<Session> {
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
    if (!options.apiKey.startsWith("ag9_uak_") && !options.apiKey.startsWith("ag9_uak.")) {
      throw new TypeError("UserClient requires a User API Key");
    }
    if (!/^[a-z0-9_-]{1,64}$/.test(options.projectId)) {
      throw new TypeError("projectId must contain 1-64 lowercase letters, numbers, _ or -");
    }
    this.#http = new HttpClient(options);
  }

  async listAgents(options?: { signal?: AbortSignal }): Promise<Agent[]> {
    const response = await this.#http.get<{ agents: AgentRecord[] }>("/api/agents", options);
    return response.agents.map((agent) => new Agent(this.#http, agent));
  }

  async createAgent(input: CreateAgentInput = {}): Promise<Agent> {
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      "/api/agents",
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.agentTemplateId === undefined
          ? {}
          : { agentTemplateId: input.agentTemplateId }),
        ...(input.config === undefined ? {} : { config: input.config }),
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
