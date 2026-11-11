import { OutcomeUnknownError } from "./errors.js";
import {
  HttpClient,
  requireCreationKey,
  requireKnownKeys,
  requestOptions,
  type HttpResult,
} from "./http.js";
import type { RequestOptions } from "./organization.js";

export type TemplateRealtimeLanguage = "zh-CN" | "en-US";

/**
 * The definition of an Agent Template. Fields the SDK does not model are
 * returned and accepted unchanged.
 */
export interface TemplateContent {
  schemaVersion?: "agent-template-content@7";
  identity: { agentName: string; description?: string };
  instructions?: string;
  /** A Sandbox profile from `templates.catalog()`. */
  sandbox: { profileId: string };
  /** The language of voice conversations on Sessions created from it. */
  realtime: { language: TemplateRealtimeLanguage };
  /** Published Skill versions from `skills` or `templates.catalog()`. */
  skills?: { skillId: string; version: number }[];
  capabilities?: { sessionRecall?: { enabled?: boolean } };
  /** A task the voice model keeps working on across a Realtime connection. */
  standingTask?: { goal: string };
  [field: string]: unknown;
}

export interface TemplateSummary {
  id: string;
  organizationId: string;
  name: string;
  displayName: string;
  sandboxProfile: string;
  lifecycleStatus: "active" | "archived";
  /** Pass this exact value as `ifMatch` to replace or archive the Template. */
  etag: string;
  contentDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  template: TemplateSummary;
  content: TemplateContent;
}

export interface TemplatePage {
  data: TemplateSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  readAt: string;
}

export interface TemplateListOptions extends RequestOptions {
  sort?: "updated_desc" | "created_desc" | "name_asc";
  /** Defaults to the service's choice when omitted. */
  lifecycleStatus?: "all" | "active" | "archived";
  /** Text search over Template names. */
  q?: string;
  limit?: number;
  cursor?: string;
}

/** What a Template may reference in this Organization. */
export interface TemplateCatalog {
  models: { id: string; available: boolean }[];
  sandboxes: { id: string; label: string; capabilities: string[] }[];
  skills: {
    skillId: string;
    name: string;
    description: string;
    version: number;
    available: boolean;
  }[];
}

export interface TemplateInput {
  displayName: string;
  content: TemplateContent;
}

export interface CreateTemplateInput extends TemplateInput, RequestOptions {
  /** Keep the same key and input when recovering an uncertain creation. */
  idempotencyKey: string;
}

export interface TemplateMutationOptions extends RequestOptions {
  /** The `etag` of the Template version you read. A stale value is refused with ConflictError. */
  ifMatch: string;
  /** Keep the same key and input when recovering an uncertain change. */
  idempotencyKey: string;
}

const templatePath = (id: string) =>
  `/agent-templates/${encodeURIComponent(id)}`;

const templateReceipt = (result: HttpResult<Template>): Template => {
  if (
    typeof result.data?.template?.id !== "string" ||
    !result.data.template.id ||
    typeof result.data.content !== "object" ||
    result.data.content === null
  )
    throw new OutcomeUnknownError(
      "Template mutation returned no usable Template; repeat it with the same idempotency key",
      { requestId: result.requestId },
    );
  return result.data;
};

const requireTemplateInput = (input: TemplateInput, label: string): void => {
  if (typeof input.displayName !== "string" || !input.displayName.trim())
    throw new TypeError(`${label} requires a displayName`);
  if (
    typeof input.content !== "object" ||
    input.content === null ||
    Array.isArray(input.content)
  )
    throw new TypeError(`${label} requires content`);
};

const requireMutationOptions = (
  options: TemplateMutationOptions,
  label: string,
): void => {
  requireKnownKeys(
    options,
    ["ifMatch", "idempotencyKey", "signal", "requestId"],
    `${label} options`,
  );
  if (typeof options.ifMatch !== "string" || !options.ifMatch)
    throw new TypeError(`${label} requires ifMatch`);
  requireCreationKey(options.idempotencyKey);
};

/** Organization Agent Templates: what Sessions are created from. */
export class Templates {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async list(options: TemplateListOptions = {}): Promise<TemplatePage> {
    requireKnownKeys(
      options,
      ["sort", "lifecycleStatus", "q", "limit", "cursor", "signal", "requestId"],
      "Template list options",
    );
    const { signal, requestId, ...filters } = options;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, String(value));
    return this.#http.get(
      `/agent-templates${query.size ? `?${query}` : ""}`,
      { ...(signal ? { signal } : {}), ...(requestId ? { requestId } : {}) },
    );
  }

  get(templateId: string, options?: RequestOptions): Promise<Template> {
    return this.#http.get(templatePath(templateId), requestOptions(options));
  }

  /** Models, Sandbox profiles and published Skills a Template may use. */
  catalog(options?: RequestOptions & { limit?: number }): Promise<TemplateCatalog> {
    requireKnownKeys(
      options ?? {},
      ["limit", "signal", "requestId"],
      "Template catalog options",
    );
    const { limit, ...request } = options ?? {};
    return this.#http.get(
      `/agent-template-reference-catalog${limit === undefined ? "" : `?limit=${limit}`}`,
      request,
    );
  }

  async create(input: CreateTemplateInput): Promise<Template> {
    requireKnownKeys(
      input,
      ["displayName", "content", "idempotencyKey", "signal", "requestId"],
      "Template creation",
    );
    requireTemplateInput(input, "Template creation");
    requireCreationKey(input.idempotencyKey);
    const { idempotencyKey, signal, requestId, ...body } = input;
    return templateReceipt(
      await this.#http.postResponse<Template>("/agent-templates", body, {
        idempotencyKey,
        idempotent: true,
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      }),
    );
  }

  /** Replace the whole definition. Sessions already created keep their snapshot. */
  async replace(
    templateId: string,
    input: TemplateInput,
    options: TemplateMutationOptions,
  ): Promise<Template> {
    requireKnownKeys(input, ["displayName", "content"], "Template replacement");
    requireTemplateInput(input, "Template replacement");
    requireMutationOptions(options, "Template replacement");
    const { ifMatch, idempotencyKey, ...request } = options;
    return templateReceipt(
      await this.#http.response<Template>(templatePath(templateId), {
        method: "PUT",
        body: input,
        ifMatch,
        idempotencyKey,
        retry: "safe",
        outcomeUnknown: true,
        ...request,
      }),
    );
  }

  /** Archive the Template; it can no longer be used to create Sessions. */
  async archive(
    templateId: string,
    options: TemplateMutationOptions,
  ): Promise<Template> {
    requireMutationOptions(options, "Template archive");
    const { ifMatch, idempotencyKey, ...request } = options;
    return templateReceipt(
      await this.#http.postResponse<Template>(
        `${templatePath(templateId)}/archive`,
        {},
        {
          ifMatch,
          idempotencyKey,
          idempotent: true,
          outcomeUnknown: true,
          ...request,
        },
      ),
    );
  }
}
