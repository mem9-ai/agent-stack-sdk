import { HttpClient, requireKnownKeys } from "./http.js";
import {
  collectTurn,
  type CreateTurnInput,
  streamTurn,
  type TurnResult,
  type TurnStreamEvent,
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
  userFiles?: unknown[];
  operations: unknown[];
  assistantMessage: MessageRecord | null;
  clarificationItem?: ClarificationItem;
  createdAt: string;
  completedAt?: string;
  sourceFireId?: string | null;
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

  streamTurn(input: CreateTurnInput): AsyncGenerator<TurnStreamEvent> {
    return streamTurn(this.#http, this.id, input);
  }

  turn(input: CreateTurnInput): Promise<TurnResult> {
    return collectTurn(this.#http, this.id, input);
  }
}

export const createSessionForAgent = async (
  http: HttpClient,
  agentId: string,
  options?: { billingTag?: BillingTag | null; signal?: AbortSignal },
): Promise<Session> => {
  if (options) requireKnownKeys(options, ["billingTag", "signal"], "Session options");
  const result = await http.postResponse<{ session: SessionRecord }>(
    "/api/v1/sessions",
    {
      agentId,
      ...(options?.billingTag === undefined ? {} : { billingTag: options.billingTag }),
    },
    {
      outcomeUnknown: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return new Session(http, result.data.session.sessionId, result.data.session);
};
