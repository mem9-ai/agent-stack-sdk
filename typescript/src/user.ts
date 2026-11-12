import { UserFiles } from "./files.js";
import {
  requestOptions,
  HttpClient,
  paginationQuery,
  requireKnownKeys,
  setTemplateFilter,
  type ListOptions,
} from "./http.js";
import type { RequestOptions } from "./organization.js";
import {
  createSession,
  type CreateSessionOptions,
  Session,
  type SessionRecord,
} from "./session.js";
import type { RealtimeModelCatalog } from "./realtime.js";

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

export interface SessionListOptions extends ListOptions {
  /** Only Sessions currently on this Template. */
  templateId?: string;
}

export interface SessionPage {
  sessions: Session[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Ordinary End User resources under the caller's authority. */
export class EndUserClient {
  readonly #http: HttpClient;
  readonly #files: UserFiles;

  get files(): UserFiles {
    return this.#files;
  }

  constructor(http: HttpClient) {
    this.#http = http;
    this.#files = new UserFiles(http);
  }

  /**
   * Create a Session from an explicit Template. The Session freezes the
   * Template recipe, digest and these creation options.
   */
  createSession(options: CreateSessionOptions): Promise<Session> {
    return createSession(this.#http, options);
  }

  listAgentTemplates(options?: ListOptions): Promise<AgentTemplatePage> {
    return this.#http.get(
      `/agent-templates${paginationQuery(options)}`,
      options,
    );
  }

  listModels(options?: RequestOptions): Promise<AgentModelCatalog> {
    if (options)
      requireKnownKeys(options, ["signal", "requestId"], "Model list options");
    return this.#http.get("/agent-models", options);
  }

  listRealtimeModels(options?: RequestOptions): Promise<RealtimeModelCatalog> {
    return this.#http.get("/realtime-models", requestOptions(options));
  }

  async listSessions(options?: SessionListOptions): Promise<SessionPage> {
    if (options)
      requireKnownKeys(
        options,
        ["templateId", "limit", "cursor", "signal", "requestId"],
        "Session list options",
      );
    const { templateId, ...page } = options ?? {};
    const query = new URLSearchParams(paginationQuery(page));
    setTemplateFilter(query, templateId);
    const response = await this.#http.get<{
      sessions: SessionRecord[];
      hasMore: boolean;
      nextCursor: string | null;
    }>(`/sessions${query.size ? `?${query}` : ""}`, options);
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
