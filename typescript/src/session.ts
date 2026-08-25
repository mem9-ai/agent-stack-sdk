import { HttpClient, requireEtag } from "./http.js";
import {
  collectTurn,
  type CreateTurnInput,
  streamTurn,
  type TurnResult,
  type TurnStreamEvent,
} from "./turn.js";

export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  projectId: string;
  name: string | null;
  autoTitle: string | null;
  ownerUserId: string | null;
  startedByUserId: string | null;
  createdByType: "user" | "scheduler" | "lark";
  readOnly: boolean;
  sourceSchedulerId: string | null;
  sourceSchedulerFireId: string | null;
  clientTag: "tui" | null;
  model: string;
  modelRevision: number;
  createdWithAgentId: string | null;
  modelPolicyStatus: "allowed" | "workspace_disallowed";
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
      response?: { text: string; answers: [string]; responseTurnId: string };
    }
  | {
      prompt: string;
      selectionMode: "multiple";
      answerChoices: [string, string, ...string[]];
      response?: { text: string; answers: [string, ...string[]]; responseTurnId: string };
    };

export interface TurnRecord {
  id: string;
  sessionId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
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

  get model(): string | undefined {
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

  async setModel(model: string, options?: { signal?: AbortSignal }): Promise<this> {
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
  options?: { signal?: AbortSignal },
): Promise<Session> => {
  const result = await http.postResponse<{ session: SessionRecord }>(
    "/api/sessions",
    { agentId },
    {
      outcomeUnknown: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return new Session(http, result.data.session.sessionId, result.data.session, requireEtag(result));
};
