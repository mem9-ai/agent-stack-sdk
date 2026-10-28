import {
  audioTurn,
  streamAudio,
  type AudioTurnInput,
  type AudioTurnEvent,
  type AudioTurnResult,
} from "./audio.js";
import {
  getClientTools,
  replaceClientTools,
  validateClientTools,
  listPendingClientToolCalls,
  submitClientToolOutput,
  type PendingClientToolCall,
  type ClientToolOutputInput,
  type ClientToolDeclaration,
  type ClientToolSet,
  type ReplaceClientToolsOptions,
} from "./client-tools.js";
import {
  submitTurnCommand,
  type TurnCommandInput,
  type RetryReceipt,
} from "./control.js";
import {
  sessionEvents,
  observeTurn,
  type SessionEvent,
  type SessionEventsOptions,
  type ObserveTurnOptions,
  type TurnObservation,
} from "./progress.js";
import { OutcomeUnknownError } from "./errors.js";
import type { RequestOptions } from "./organization.js";
import {
  requestOptions,
  HttpClient,
  requireEtag,
  requireKnownKeys,
  requireCreationKey,
} from "./http.js";
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
  submitMessage,
  waitForResult,
  validateWaitOptions,
  type CreateTurnInput,
  type TurnResult,
  type WaitForResultOptions,
} from "./turn.js";
import {
  getInteraction,
  reconcileInteraction,
  listInteractions,
  history,
  getTurn,
  timeline,
  type SessionInteraction,
  type SessionInteractionPage,
  type TurnRecord,
  type TurnPage,
  type SessionTimelinePage,
} from "./history.js";
import type { ListOptions } from "./http.js";

/** Model IDs come from the deployment catalog, including newly published models. */
export type SelectableSessionModel = string;
export type SessionModel = string;

export interface CreateSessionOptions extends RequestOptions {
  idempotencyKey: string;
  model?: string;
  realtimeModel?: string;
  billingTag?: BillingTag | null;
  tools?: ClientToolDeclaration[];
}

export interface SuggestSessionNameInput {
  userText: string;
  assistantText?: string;
}

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
  createdByType: "user" | "scheduler" | "template_preview";
  readOnly: boolean;
  sourceSchedulerId: string | null;
  sourceSchedulerFireId: string | null;
  billingTag: BillingTag | null;
  model: SessionModel;
  modelRevision: number;
  realtimeModel: string | null;
  realtimeModelRevision: number;
  realtimeModelEtag: string;
  realtimeVoice: import("./realtime.js").RealtimeVoiceSetting | null;
  template?: { templateId: string; contentDigest: string } | null;
  realtime: {
    id: string;
    status: "connecting" | "active" | "paused";
    audio: import("./realtime.js").RealtimeAudioFormats;
    startedAt: string;
  } | null;
  createdWithAgentId: string;
  modelPolicyStatus: "allowed" | "organization_disallowed";
  status: "active" | "deleted";
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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

export class Session {
  readonly #http: HttpClient;
  readonly id: string;
  #etag: string | undefined;
  #record: SessionRecord | undefined;

  constructor(
    http: HttpClient,
    id: string,
    record?: SessionRecord,
    etag?: string,
  ) {
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

  async refresh(options?: RequestOptions): Promise<this> {
    options = requestOptions(options);
    const result = await this.#http.getResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}`,
      options,
    );
    const etag = requireEtag(result);
    this.#record = result.data.session;
    this.#etag = etag;
    return this;
  }

  async setModel(
    model: SelectableSessionModel,
    options?: RequestOptions,
  ): Promise<this> {
    options = requestOptions(options);
    if (!this.#etag) await this.refresh(options);
    const result = await this.#http.patchResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/model`,
      { model },
      {
        ifMatch: this.#etag as string,
        outcomeUnknown: true,
        ...options,
      },
    );
    if (!result.etag)
      throw new OutcomeUnknownError(
        "Session model update returned no model ETag; read the Session before changing it again",
        { requestId: result.requestId },
      );
    this.#record = sessionReceipt(result.data, result.requestId);
    const etag = result.etag;
    this.#etag = etag;
    return this;
  }

  async rename(name: string, options?: RequestOptions): Promise<this> {
    options = requestOptions(options);
    const result = await this.#http.postResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/name`,
      { name },
      { ...options, outcomeUnknown: true },
    );
    this.#record = sessionReceipt(result.data, result.requestId);
    return this;
  }

  async suggestName(
    input: SuggestSessionNameInput,
    options?: RequestOptions,
  ): Promise<this> {
    options = requestOptions(options);
    requireKnownKeys(
      input,
      ["userText", "assistantText"],
      "Session naming input",
    );
    const result = await this.#http.postResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/name/suggest`,
      input,
      { ...options, outcomeUnknown: true },
    );
    this.#record = sessionReceipt(result.data, result.requestId);
    return this;
  }

  async setBillingTag(
    billingTag: BillingTag | null,
    options?: RequestOptions,
  ): Promise<this> {
    options = requestOptions(options);
    const result = await this.#http.patchResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/billing-tag`,
      { billingTag },
      { ...options, outcomeUnknown: true },
    );
    this.#record = sessionReceipt(result.data, result.requestId);
    return this;
  }

  async delete(options?: RequestOptions): Promise<this> {
    options = requestOptions(options);
    const result = await this.#http.deleteResponse<{ session: SessionRecord }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}`,
      { ...options, outcomeUnknown: true },
    );
    this.#record = sessionReceipt(result.data, result.requestId);
    return this;
  }

  async openRealtimeConnection(
    input: OpenRealtimeConnectionInput = {},
    options?: { signal?: AbortSignal },
  ): Promise<OpenRealtimeConnectionResult> {
    options = requestOptions(options);
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
    options = requestOptions(options);
    const response = await this.#http.get<{
      realtimeConnection: RealtimeConnection;
    }>(
      `/api/v1/user/sessions/${encodeURIComponent(this.id)}/realtime`,
      options,
    );
    return response.realtimeConnection;
  }

  async createRealtimeConnectToken(options?: {
    signal?: AbortSignal;
  }): Promise<RealtimeConnectGrant> {
    options = requestOptions(options);
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
    options = requestOptions(options);
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
    options = requestOptions(options);
    const response = await this.#http.get<{
      session: RealtimeSessionSelectionFields;
    }>(`/api/v1/user/sessions/${encodeURIComponent(this.id)}`, options);
    return realtimeModelSelectionFrom(response.session);
  }

  async setRealtimeModel(
    model: string,
    options: { ifMatch: string; signal?: AbortSignal },
  ): Promise<RealtimeModelSelection> {
    requireKnownKeys(
      options,
      ["ifMatch", "signal"],
      "Realtime Model selection options",
    );
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

  events(options?: SessionEventsOptions): AsyncGenerator<SessionEvent> {
    return sessionEvents(this.#http, this.id, options);
  }

  observe(
    inputId: string,
    options?: ObserveTurnOptions,
  ): AsyncGenerator<TurnObservation> {
    return observeTurn(this.#http, this.id, inputId, options);
  }

  streamAudio(input: AudioTurnInput): AsyncGenerator<AudioTurnEvent> {
    return streamAudio(this.#http, this.id, input);
  }

  audio(input: AudioTurnInput): Promise<AudioTurnResult> {
    return audioTurn(this.#http, this.id, input);
  }

  getClientTools(options?: RequestOptions): Promise<ClientToolSet> {
    return getClientTools(this.#http, this.id, options);
  }

  replaceClientTools(
    tools: readonly ClientToolDeclaration[],
    options: ReplaceClientToolsOptions,
  ): Promise<ClientToolSet> {
    return replaceClientTools(this.#http, this.id, tools, options);
  }

  listPendingClientToolCalls(
    options?: RequestOptions,
  ): Promise<PendingClientToolCall[]> {
    return listPendingClientToolCalls(this.#http, this.id, options);
  }

  submitClientToolOutput(
    input: ClientToolOutputInput,
  ): Promise<SessionInteraction> {
    return submitClientToolOutput(this.#http, this.id, input);
  }

  history(options?: ListOptions): Promise<TurnPage> {
    return history(this.#http, this.id, options);
  }

  getTurn(turnId: string, options?: RequestOptions): Promise<TurnRecord> {
    return getTurn(this.#http, this.id, turnId, options);
  }

  timeline(options?: ListOptions): Promise<SessionTimelinePage> {
    return timeline(this.#http, this.id, options);
  }

  listInteractions(options?: ListOptions): Promise<SessionInteractionPage> {
    return listInteractions(this.#http, this.id, options);
  }

  getInteraction(
    inputId: string,
    options?: RequestOptions,
  ): Promise<SessionInteraction> {
    return getInteraction(this.#http, this.id, inputId, options);
  }

  reconcileInteraction(
    clientEventId: string,
    options?: RequestOptions,
  ): Promise<SessionInteraction | null> {
    return reconcileInteraction(this.#http, this.id, clientEventId, options);
  }

  /** Acceptance requests cancellation; read the receipt for the eventual outcome. */
  cancel(input: TurnCommandInput): Promise<SessionInteraction> {
    return submitTurnCommand(this.#http, this.id, "cancel", input);
  }

  /** Explicit checkpoint retry has its own identity and original execution result. */
  retry(input: TurnCommandInput): Promise<RetryReceipt> {
    return submitTurnCommand(this.#http, this.id, "retry", input);
  }

  submitMessage(input: CreateTurnInput): Promise<SessionInteraction> {
    return submitMessage(this.#http, this.id, input);
  }

  waitForResult(
    inputId: string,
    options?: WaitForResultOptions,
  ): Promise<TurnResult> {
    return waitForResult(this.#http, this.id, inputId, options);
  }

  async turn(
    input: CreateTurnInput,
    options?: WaitForResultOptions,
  ): Promise<TurnResult> {
    validateWaitOptions(options);
    const waitOptions = {
      ...(input.signal ? { signal: input.signal } : {}),
      ...options,
    };
    const accepted = await this.submitMessage(input);
    return this.waitForResult(accepted.inputId, waitOptions);
  }
}

const sessionReceipt = (
  value: { session?: SessionRecord },
  requestId: string,
): SessionRecord => {
  if (
    typeof value?.session?.sessionId !== "string" ||
    !value.session.sessionId
  ) {
    throw new OutcomeUnknownError(
      "Session mutation returned no usable Session; reconcile before retrying",
      { requestId },
    );
  }
  return value.session;
};

export const createSessionForAgent = async (
  http: HttpClient,
  agentId: string,
  options: CreateSessionOptions,
): Promise<Session> => {
  requireKnownKeys(
    options,
    [
      "idempotencyKey",
      "model",
      "realtimeModel",
      "billingTag",
      "tools",
      "signal",
      "requestId",
    ],
    "Session options",
  );
  requireCreationKey(options.idempotencyKey);
  if (options.tools !== undefined) validateClientTools(options.tools);
  const { idempotencyKey, signal, requestId, ...body } = options;
  const result = await http.postResponse<{ session: SessionRecord }>(
    "/api/v1/user/sessions",
    { agentId, ...body },
    {
      idempotencyKey,
      idempotent: true,
      outcomeUnknown: true,
      ...(signal ? { signal } : {}),
      ...(requestId ? { requestId } : {}),
    },
  );
  const record = sessionReceipt(result.data, result.requestId);
  if (!result.etag)
    throw new OutcomeUnknownError(
      "Session creation returned no model ETag; recover with the same creation key",
      { requestId: result.requestId },
    );
  return new Session(http, record.sessionId, record, result.etag);
};
