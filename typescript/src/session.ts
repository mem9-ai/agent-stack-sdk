import { HttpClient, requireEtag, requireKnownKeys } from "./http.js";
import {
  realtimeModelSelectionFrom,
  requireOpenRealtimeConnectionReceipt,
  requireRealtimeConnectGrantReceipt,
  requireRealtimeConnectionReceipt,
  requireRealtimeModelSelectionReceipt,
  type OpenRealtimeConnectionInput,
  type OpenRealtimeConnectionResult,
  type RealtimeConnectGrant,
  type RealtimeConnection,
  type RealtimeModelSelection,
  type RealtimeSessionSelectionFields,
} from "./realtime.js";
import {
  collectTurn,
  type CreateTurnInput,
  streamTurn,
  type TurnResult,
  type TurnStreamEvent,
} from "./turn.js";

export type SelectableSessionModel =
  | "gpt-6-astra"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "claude-haiku-4-5"
  | "claude-sonnet-5"
  | "claude-opus-5"
  | "DeepSeek-V4-Flash";

export type SessionModel = SelectableSessionModel | "gpt-5.4";

export interface BillingTag {
  key: string;
  value: string;
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
  #etag: string | undefined;
  #record: SessionRecord | undefined;

  constructor(http: HttpClient, id: string, record?: SessionRecord, etag?: string) {
    if (!id) throw new TypeError("Session id is required");
    this.#http = http;
    this.id = id;
    this.#record = record;
    this.#etag = etag;
  }

  get data(): Readonly<SessionRecord> | undefined {
    return this.#record;
  }

  get model(): SessionModel | undefined {
    return this.#record?.model;
  }

  async refresh(options?: { signal?: AbortSignal }): Promise<this> {
    const result = await this.#http.getResponse<{ session: SessionRecord }>(
      `/api/sessions/${encodeURIComponent(this.id)}`,
      options,
    );
    this.#record = result.data.session;
    this.#etag = requireEtag(result);
    return this;
  }

  async setModel(model: SelectableSessionModel, options?: { signal?: AbortSignal }): Promise<this> {
    if (!this.#etag) await this.refresh(options);
    const result = await this.#http.patchResponse<{ session: SessionRecord }>(
      `/api/sessions/${encodeURIComponent(this.id)}/model`,
      { model },
      {
        ifMatch: this.#etag as string,
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    this.#record = result.data.session;
    this.#etag = requireEtag(result);
    return this;
  }

  async openRealtimeConnection(
    input: OpenRealtimeConnectionInput = {},
    options?: { signal?: AbortSignal },
  ): Promise<OpenRealtimeConnectionResult> {
    requireKnownKeys(input, ["audio", "metadata"], "Realtime Connection input");
    const result = await this.#http.postResponse<unknown>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime`,
      input,
      {
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return requireOpenRealtimeConnectionReceipt(result.data, result.requestId);
  }

  async getRealtimeConnection(options?: {
    signal?: AbortSignal;
  }): Promise<RealtimeConnection> {
    const response = await this.#http.get<{
      realtimeConnection: RealtimeConnection;
    }>(`/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime`, options);
    return response.realtimeConnection;
  }

  async createRealtimeConnectToken(options?: {
    signal?: AbortSignal;
  }): Promise<RealtimeConnectGrant> {
    const result = await this.#http.postResponse<unknown>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime/connect-tokens`,
      undefined,
      {
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return requireRealtimeConnectGrantReceipt(result.data, result.requestId);
  }

  async endRealtimeConnection(options?: {
    signal?: AbortSignal;
  }): Promise<RealtimeConnection> {
    const result = await this.#http.deleteResponse<unknown>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime`,
      {
        outcomeUnknown: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return requireRealtimeConnectionReceipt(result.data, result.requestId);
  }

  async getRealtimeModelSelection(options?: {
    signal?: AbortSignal;
  }): Promise<RealtimeModelSelection> {
    const response = await this.#http.get<{
      session: RealtimeSessionSelectionFields;
    }>(`/api/v1/user/sessions/${encodeURIComponent(this.id)}`, options);
    return realtimeModelSelectionFrom(response.session);
  }

  async setRealtimeModel(
    model: string,
    options: { ifMatch: string; signal?: AbortSignal },
  ): Promise<RealtimeModelSelection> {
    requireKnownKeys(options, ["ifMatch", "signal"], "Realtime Model selection options");
    if (!model || model.length > 128)
      throw new TypeError("Realtime Model ID must contain 1-128 characters");
    if (!options.ifMatch)
      throw new TypeError("Realtime Model selection requires ifMatch");
    const result = await this.#http.patchResponse<unknown>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime-model`,
      { realtimeModel: model },
      {
        ifMatch: options.ifMatch,
        outcomeUnknown: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const receipt = result.data as { session?: unknown } | null | undefined;
    return requireRealtimeModelSelectionReceipt(
      receipt?.session,
      result.requestId,
    );
  }

  async history(options?: { signal?: AbortSignal }): Promise<TurnRecord[]> {
    const response = await this.#http.get<{ turns: TurnRecord[] }>(
      `/api/sessions/${encodeURIComponent(this.id)}/turns`,
      options,
    );
    return response.turns;
  }

  async getTurn(turnId: string, options?: { signal?: AbortSignal }): Promise<TurnRecord> {
    const response = await this.#http.get<{ turn: TurnRecord }>(
      `/api/sessions/${encodeURIComponent(this.id)}/turns/${encodeURIComponent(turnId)}`,
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
    "/api/sessions",
    {
      agentId,
      ...(options?.billingTag === undefined ? {} : { billingTag: options.billingTag }),
    },
    {
      outcomeUnknown: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return new Session(http, result.data.session.sessionId, result.data.session, requireEtag(result));
};
