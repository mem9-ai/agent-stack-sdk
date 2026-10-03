import { TiDBLinkError } from "./errors.js";
import { HttpClient, requireKnownKeys, requireStableIdentity } from "./http.js";
import {
  collectTurn,
  decodeInteraction,
  type CreateTurnInput,
  streamTurn,
  stopTurn,
  type StopTurnInput,
  type InteractionReceipt,
  type TurnResult,
  type TurnStreamItem,
} from "./turn.js";

export type SessionModel =
  | "gpt-6-astra"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "claude-haiku-4-5"
  | "claude-sonnet-5"
  | "claude-opus-5"
  | "DeepSeek-V4-Flash"
  | "gpt-5.4";

export interface BillingTag {
  key: string;
  value: string;
}

export interface SessionTemplateProvenance {
  templateId: string;
  version: number;
  contentDigest: string;
}

export interface SessionRecord {
  organizationId: string;
  sessionId: string;
  name: string | null;
  autoTitle: string | null;
  ownerUserId: string;
  startedByUserId: string;
  createdByType: "user" | "scheduler" | "voice";
  readOnly: boolean;
  sourceSchedulerId: string | null;
  sourceSchedulerFireId: string | null;
  sourceVoiceSessionId: string | null;
  billingTag: BillingTag | null;
  model: SessionModel;
  modelRevision: number;
  createdWithAgentId: string;
  template: SessionTemplateProvenance | null;
  modelPolicyStatus: "allowed" | "organization_disallowed";
  status: "active" | "deleted";
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type ClarificationItem =
  | {
      prompt: string;
      selectionMode: "single";
      answerChoices: [string, string, string?];
      response?: { answers: [string]; responseTurnId: string };
    }
  | {
      prompt: string;
      selectionMode: "multiple";
      answerChoices: [string, string, ...string[]];
      response?: { answers: [string, ...string[]]; responseTurnId: string };
    };

export interface TurnRecord {
  id: string;
  sessionId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  billingTag: BillingTag | null;
  userMessage: MessageRecord;
  userMessages: MessageRecord[];
  userFiles?: unknown[];
  operations: unknown[];
  assistantMessage: MessageRecord | null;
  clarificationItem?: ClarificationItem;
  createdAt: string;
  completedAt?: string;
  sourceFireId?: string | null;
}

export interface Interaction {
  inputId: string;
  sequence: number;
  kind: "message" | "cancel";
  mode: "started" | "steered" | "cancelled" | "rejected";
  turnId: string;
  message: { id: string; role: "user"; content: string; createdAt: string } | null;
  createdAt: string;
  appliedAt: string | null;
  rejection: { code: "interaction_admission_closed" | "interaction_target_conflict" } | null;
  result: { status: "running" | "succeeded" | "failed" | "interrupted"; completedAt: string | null };
}

export interface InteractionPage {
  interactions: Interaction[];
  hasMore: boolean;
  nextCursor: string | null;
}

export class Session {
  readonly #http: HttpClient;
  readonly id: string;
  #record: SessionRecord | undefined;

  constructor(http: HttpClient, id: string, record?: SessionRecord) {
    if (!id) throw new TypeError("Session id is required");
    this.#http = http;
    this.id = id;
    this.#record = record;
  }

  get data(): Readonly<SessionRecord> | undefined {
    return this.#record;
  }

  get model(): SessionModel | undefined {
    return this.#record?.model;
  }

  async refresh(options?: { signal?: AbortSignal }): Promise<this> {
    const result = await this.#http.getResponse<{ session: SessionRecord }>(
      `/api/v1/sessions/${encodeURIComponent(this.id)}`,
      options,
    );
    this.#record = result.data.session;
    return this;
  }

  async rename(name: string, options?: { signal?: AbortSignal }): Promise<this> {
    const response = await this.#http.post<{ session: SessionRecord }>(`/api/v1/sessions/${encodeURIComponent(this.id)}/name`, { name }, { outcomeUnknown: true, ...options });
    this.#record = response.session;
    return this;
  }

  async setBillingTag(billingTag: BillingTag | null, options?: { signal?: AbortSignal }): Promise<this> {
    const result = await this.#http.patchResponse<{ session: SessionRecord }>(`/api/v1/sessions/${encodeURIComponent(this.id)}/billing-tag`, { billingTag }, { outcomeUnknown: true, ...options });
    this.#record = result.data.session;
    return this;
  }

  async delete(options?: { signal?: AbortSignal }): Promise<void> {
    const response = await this.#http.delete<{ session: SessionRecord }>(`/api/v1/sessions/${encodeURIComponent(this.id)}`, options);
    this.#record = response.session;
  }

  async history(options?: { signal?: AbortSignal }): Promise<TurnRecord[]> {
    const response = await this.#http.get<{ turns: TurnRecord[] }>(
      `/api/v1/sessions/${encodeURIComponent(this.id)}/turns`,
      options,
    );
    return response.turns;
  }

  async getTurn(turnId: string, options?: { signal?: AbortSignal }): Promise<TurnRecord> {
    const response = await this.#http.get<{ turn: TurnRecord }>(
      `/api/v1/sessions/${encodeURIComponent(this.id)}/turns/${encodeURIComponent(turnId)}`,
      options,
    );
    return response.turn;
  }

  async listInteractions(options?: { limit?: number; cursor?: string; signal?: AbortSignal }): Promise<InteractionPage> {
    const query = new URLSearchParams();
    if (options) requireKnownKeys(options, ["limit", "cursor", "signal"], "Interaction page options");
    if (options?.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new TypeError("limit must be 1-200");
      query.set("limit", String(options.limit));
    }
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    const response = await this.#http.getResponse<{ interactions: unknown[]; hasMore: boolean; nextCursor: string | null }>(`/api/v1/sessions/${encodeURIComponent(this.id)}/interactions${query.size ? `?${query}` : ""}`, options);
    if (!response.data || !Array.isArray(response.data.interactions) || typeof response.data.hasMore !== "boolean" || !(response.data.nextCursor === null || typeof response.data.nextCursor === "string")) throw new TiDBLinkError("TiDB Link returned an invalid interaction page", { requestId: response.requestId });
    return { interactions: response.data.interactions.map(value => decodeInteraction(value, { requestId: response.requestId })), hasMore: response.data.hasMore, nextCursor: response.data.nextCursor };
  }

  async getInteraction(inputId: string, options?: { signal?: AbortSignal }): Promise<Interaction> {
    requireStableIdentity(inputId, "inputId");
    const response = await this.#http.getResponse<{ interaction: unknown }>(`/api/v1/sessions/${encodeURIComponent(this.id)}/interactions/${encodeURIComponent(inputId)}`, options);
    return decodeInteraction(response.data?.interaction, { requestId: response.requestId, inputId });
  }

  stopTurn(turnId: string, input: StopTurnInput): Promise<InteractionReceipt> {
    return stopTurn(this.#http, this.id, turnId, input);
  }

  streamTurn(input: CreateTurnInput): AsyncGenerator<TurnStreamItem> {
    return streamTurn(this.#http, this.id, input);
  }

  turn(input: CreateTurnInput): Promise<TurnResult> {
    return collectTurn(this.#http, this.id, input);
  }
}

export interface CreateSessionOptions {
  idempotencyKey: string;
  billingTag?: BillingTag | null;
  signal?: AbortSignal;
}

export const createSessionForAgent = async (
  http: HttpClient,
  agentId: string,
  options: CreateSessionOptions,
): Promise<Session> => {
  requireKnownKeys(options, ["idempotencyKey", "billingTag", "signal"], "Session options");
  requireStableIdentity(options.idempotencyKey, "idempotencyKey");
  const result = await http.postResponse<{ session: SessionRecord }>(
    "/api/v1/sessions",
    {
      agentId,
      ...(options?.billingTag === undefined ? {} : { billingTag: options.billingTag }),
    },
    {
      outcomeUnknown: true,
      idempotencyKey: options.idempotencyKey,
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return new Session(http, result.data.session.sessionId, result.data.session);
};
