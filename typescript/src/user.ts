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

/** Descriptive exact metadata references; these neither assign devices nor grant execution. */
export interface HardwareRequirement {
  definitionId: string;
  capabilityNames: string[];
}

export interface TemplateOverrides {
  identity?: { agentName?: string };
  instructions?: string;
  sandbox?: { profileId?: string };
  capabilities?: {
    memory?: EnabledAgentCapability;
    sessionRecall?: EnabledAgentCapability;
    generatedMedia?: EnabledAgentCapability;
  };
  tools?: { mcp?: McpServerReference[] };
  skills?: { skillId: string; version: number }[];
  hardware?: { requirements: HardwareRequirement[] };
}

export interface TemplateApplicationReference {
  templateId: string;
  version: number;
  contentDigest: string;
}

interface TemplateContentFields {
  identity: { agentName: string; description: string };
  instructions: string;
  sandbox: { profileId: string };
  capabilities: {
    memory: EnabledAgentCapability;
    sessionRecall: EnabledAgentCapability;
    generatedMedia: EnabledAgentCapability;
  };
  tools: { mcp: McpServerReference[] };
  skills: { skillId: string; version: number }[];
}
export type TemplateContent = TemplateContentFields &
  (
    | { schemaVersion: "agent-template-content@1"; hardware?: never }
    | {
        schemaVersion: "agent-template-content@2";
        hardware: { requirements: HardwareRequirement[] };
      }
  );
export interface PublishedTemplateVersion {
  agentTemplateId: string;
  templateVersion: number;
  contentDigest: string;
  content: TemplateContent;
  availability: "available";
}
export type TemplateOverridePath =
  | "identity.agentName"
  | "instructions"
  | "sandbox.profileId"
  | "capabilities.memory.enabled"
  | "capabilities.sessionRecall.enabled"
  | "capabilities.generatedMedia.enabled"
  | "tools.mcp"
  | "skills"
  | "hardware.requirements";
export interface ApplyTemplateInput {
  agentTemplateId: string;
  templateVersion: number;
  expectedApplication: TemplateApplicationReference | null;
  resetOverridePaths?: TemplateOverridePath[];
  overrides?: TemplateOverrides;
  adoption?: boolean;
  acknowledgeSessionRecall?: boolean;
  memoryCredential?: MemoryCredentialInput;
}
export interface TemplateApplicationPreview {
  currentAgent: AgentRecord;
  etag: string;
  targetRef: TemplateApplicationReference;
  nextEffective: {
    name: string;
    instructions: string;
    sandboxProfile: string;
    config: AgentConfigInput & {
      memory?: EnabledAgentCapability & {
        provider: "mem9";
        mem9: Record<string, never>;
      };
    };
    skillInstallations: { skillId: string; version: number }[];
  };
  nextOverrides: TemplateOverrides;
  changes: {
    path: TemplateOverridePath;
    before: unknown;
    after: unknown;
    source: "template" | "override";
  }[];
  warnings: (
    | "agent_template_apply_busy"
    | "agent_template_memory_setup_required"
    | "agent_template_recall_acknowledgment_required"
  )[];
}

export interface AgentConfigInput {
  hardware?: { requirements: HardwareRequirement[] };
  memory?: EnabledAgentCapability;
  sessionRecall?: EnabledAgentCapability;
  generatedMedia?: EnabledAgentCapability;
  tools?: { mcp?: McpServerReference[] };
}

export interface AgentConfigPatch extends AgentConfigInput {
  sandboxProfile?: string;
  instructions?: string;
}

export interface PublicAgentConfig {
  hardware?: { requirements: HardwareRequirement[] };
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
  instructions: string;
  creationOrigin:
    | {
        kind: "published_template";
        templateId: string;
        version: number;
        contentDigest: string;
      }
    | { kind: "legacy_unknown"; legacyTemplateId: string | null }
    | { kind: "draft_preview"; snapshotId: string };
  templateApplication:
    | (TemplateApplicationReference & { overrides: TemplateOverrides })
    | null;
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
  agentTemplateId: string;
  templateVersion?: number;
  overrides?: TemplateOverrides;
  acknowledgeSessionRecall?: boolean;
  config?: AgentConfigInput;
  memoryCredential?: MemoryCredentialInput;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const validateAgentConfig = (
  config: AgentConfigInput | AgentConfigPatch,
  patch: boolean,
): void => {
  requireKnownKeys(
    config,
    [
      "memory",
      "sessionRecall",
      "generatedMedia",
      "tools",
      "hardware",
      ...(patch ? ["sandboxProfile", "instructions"] : []),
    ],
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
  if (config.hardware !== undefined) {
    requireKnownKeys(
      config.hardware,
      ["requirements"],
      "Agent config.hardware",
    );
    if (!Array.isArray(config.hardware.requirements))
      throw new TypeError("Hardware requirements must be an array");
    for (const requirement of config.hardware.requirements) {
      requireKnownKeys(
        requirement,
        ["definitionId", "capabilityNames"],
        "Hardware requirement",
      );
      if (
        typeof requirement.definitionId !== "string" ||
        !/^hdef_[0-9a-f]{32}$/.test(requirement.definitionId) ||
        !Array.isArray(requirement.capabilityNames) ||
        requirement.capabilityNames.some(
          (name) => typeof name !== "string" || !name.trim(),
        )
      )
        throw new TypeError(
          "Hardware requirement must contain an exact Definition and capability names",
        );
    }
  }
  if (config.tools === undefined) return;
  requireKnownKeys(config.tools, ["mcp"], "Agent config.tools");
  if (config.tools.mcp === undefined) return;
  if (!Array.isArray(config.tools.mcp))
    throw new TypeError("Agent config.tools.mcp must be an array");
  for (const server of config.tools.mcp) {
    requireKnownKeys(server, ["serverId"], "Agent config.tools.mcp entry");
    if (typeof server.serverId !== "string") {
      throw new TypeError(
        "Agent config.tools.mcp entry.serverId must be a string",
      );
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

  async rename(
    name: string,
    options?: { signal?: AbortSignal },
  ): Promise<this> {
    const etag = await this.#currentEtag(options);
    const result = await this.#http.patchResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}/name`,
      { name },
      {
        ifMatch: etag,
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
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
      {
        ifMatch: etag,
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    this.#record = result.data.agent;
    this.#etag = requireEtag(result);
    return this;
  }

  previewTemplateApplication(
    input: ApplyTemplateInput,
    options?: { signal?: AbortSignal },
  ): Promise<TemplateApplicationPreview> {
    return this.#http.post(
      `/api/agents/${encodeURIComponent(this.id)}/template-application-previews`,
      input,
      {
        idempotent: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
  }

  async applyTemplate(
    input: ApplyTemplateInput,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<this> {
    const etag = await this.#currentEtag(options);
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(this.id)}/template-applications`,
      input,
      {
        ifMatch: etag,
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
        idempotent: true,
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
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
      {
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    this.#record = response.agent;
    this.#etag = undefined;
    return this;
  }

  async makeDefault(options?: { signal?: AbortSignal }): Promise<this> {
    await this.#http.put(
      "/api/agents/default",
      { agentId: this.id },
      {
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return this;
  }

  async archive(options?: { signal?: AbortSignal }): Promise<void> {
    const etag = await this.#currentEtag(options);
    await this.#http.postResponse(
      `/api/agents/${encodeURIComponent(this.id)}/archive`,
      undefined,
      {
        ifMatch: etag,
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
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
    this.#http = new HttpClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
    });
  }

  async listAgents(options?: { signal?: AbortSignal }): Promise<Agent[]> {
    const response = await this.#http.get<{ agents: AgentRecord[] }>(
      "/api/agents",
      options,
    );
    return response.agents.map((agent) => new Agent(this.#http, agent));
  }

  validateMemoryKey(
    mem9Key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ valid: true }> {
    return this.#http.post(
      "/api/agents/memory/mem9/key-validations",
      { mem9Key },
      {
        idempotent: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    requireKnownKeys(
      input,
      [
        "name",
        "agentTemplateId",
        "templateVersion",
        "overrides",
        "acknowledgeSessionRecall",
        "config",
        "memoryCredential",
        "idempotencyKey",
        "signal",
      ],
      "Agent creation",
    );
    if (
      typeof input.agentTemplateId !== "string" ||
      !input.agentTemplateId.trim()
    )
      throw new TypeError(
        "Agent creation requires an explicit published Template ID",
      );
    if (
      input.templateVersion !== undefined &&
      (!Number.isInteger(input.templateVersion) || input.templateVersion <= 0)
    )
      throw new TypeError("Template version must be a positive integer");
    if (input.config !== undefined) validateAgentConfig(input.config, false);
    if (input.memoryCredential !== undefined) {
      requireKnownKeys(
        input.memoryCredential,
        ["mode", "mem9Key"],
        "Memory credential",
      );
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
        ...(input.templateVersion === undefined
          ? {}
          : { templateVersion: input.templateVersion }),
        ...(input.overrides === undefined
          ? {}
          : { overrides: input.overrides }),
        ...(input.acknowledgeSessionRecall === undefined
          ? {}
          : { acknowledgeSessionRecall: input.acknowledgeSessionRecall }),
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

  async getAgent(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<Agent> {
    const result = await this.#http.getResponse<{ agent: AgentRecord }>(
      `/api/agents/${encodeURIComponent(id)}`,
      options,
    );
    return new Agent(this.#http, result.data.agent, requireEtag(result));
  }

  async getOrCreateDefaultAgent(options?: {
    signal?: AbortSignal;
  }): Promise<Agent> {
    const result = await this.#http.postResponse<{ agent: AgentRecord }>(
      "/api/agents/default/ensure",
      undefined,
      {
        idempotent: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return new Agent(this.#http, result.data.agent, requireEtag(result));
  }

  getPublishedTemplateVersion(
    templateId: string,
    version: number,
    options?: { signal?: AbortSignal },
  ): Promise<PublishedTemplateVersion> {
    if (!Number.isInteger(version) || version <= 0)
      throw new TypeError("Template version must be a positive integer");
    return this.#http.get(
      `/api/agents/template-versions/${encodeURIComponent(templateId)}/${version}`,
      options,
    );
  }

  async listAgentTemplates(options?: {
    signal?: AbortSignal;
  }): Promise<AgentTemplate[]> {
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
