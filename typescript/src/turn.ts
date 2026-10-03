import {
  TiDBLinkError,
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
} from "./errors.js";
import { HttpClient, type HttpStream, requireKnownKeys, requireStableIdentity } from "./http.js";
import type { BillingTag, ClarificationItem, Interaction, SessionModel } from "./session.js";

type TurnEvent<Event extends string, Payload> = {
  event: Event;
  turnId: string;
  sessionId: string;
  agentRunId?: string;
  seq: number;
  createdAt: string;
  payload: Payload;
};

export type TurnStreamEvent =
  | TurnEvent<
      "turn_started",
      {
        inputId: string;
        execution?: {
          model: SessionModel;
        };
      }
    >
  | TurnEvent<"progress", { text: string }>
  | TurnEvent<"assistant_draft", { text: string }>
  | TurnEvent<
      "operation_step",
      {
        operationId: string;
        status: "running" | "succeeded" | "failed" | "interrupted" | "unknown_result";
        label: string;
      }
    >
  | TurnEvent<
      "assistant_message",
      { messageId: string; text: string; clarificationItem?: ClarificationItem }
    >
  | TurnEvent<"turn_error", { code: string; message: string }>
  | TurnEvent<"turn_finished", { status: "succeeded" | "failed" | "interrupted" }>;

export interface CreateTurnInput {
  inputId: string;
  text: string | [string, ...string[]];
  userFileIds?: string[];
  clarificationSourceTurnId?: string;
  billingTag?: BillingTag | null;
  requestId?: string;
  signal?: AbortSignal;
}

export interface StopTurnInput {
  inputId: string;
  requestId?: string;
  signal?: AbortSignal;
}

export interface InteractionReceipt {
  type: "receipt";
  replayed: boolean;
  interaction: Interaction;
}

export type TurnStreamItem = TurnStreamEvent | InteractionReceipt;

export type TurnResult =
  | InteractionReceipt

  | { type: "answer"; turnId: string; messageId: string; text: string }
  | {
      type: "clarification";
      turnId: string;
      messageId: string;
      text: string;
      clarification: ClarificationItem;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown, minimum = 0, maximum = Infinity): value is string[] =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.length <= maximum &&
  value.every((item) => typeof item === "string" && item.length > 0);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && allowed.includes(value as T);

const clarification = (value: unknown): value is ClarificationItem => {
  if (
    !isRecord(value) ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    !oneOf(value.selectionMode, ["single", "multiple"]) ||
    !strings(value.answerChoices, 2, value.selectionMode === "single" ? 3 : 8)
  ) {
    return false;
  }
  if (value.response === undefined) return true;
  return (
    isRecord(value.response) &&
    Object.keys(value.response).sort().join(",") === "answers,responseTurnId" &&
    typeof value.response.responseTurnId === "string" &&
    strings(value.response.answers, 1, value.selectionMode === "single" ? 1 : 9)
  );
};

const validPayload = (event: string, payload: Record<string, unknown>): boolean => {
  switch (event) {
    case "turn_started": {
      if (typeof payload.inputId !== "string") return false;
      if (payload.execution === undefined) return true;
      const execution = payload.execution;
      return (
        isRecord(execution) &&
        Object.keys(execution).length === 1 &&
        oneOf(execution.model, [
          "gpt-6-astra",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "claude-haiku-4-5",
          "claude-sonnet-5",
          "claude-opus-5",
          "DeepSeek-V4-Flash",
          "gpt-5.4",
        ])
      );
    }
    case "progress":
    case "assistant_draft":
      return typeof payload.text === "string";
    case "operation_step":
      return (
        typeof payload.operationId === "string" &&
        payload.operationId.length > 0 &&
        oneOf(payload.status, ["running", "succeeded", "failed", "interrupted", "unknown_result"]) &&
        typeof payload.label === "string"
      );
    case "assistant_message":
      return (
        typeof payload.messageId === "string" &&
        payload.messageId.length > 0 &&
        typeof payload.text === "string" &&
        (payload.clarificationItem === undefined || clarification(payload.clarificationItem))
      );
    case "turn_error":
      return (
        typeof payload.code === "string" &&
        payload.code.length > 0 &&
        typeof payload.message === "string"
      );
    case "turn_finished":
      return (
        payload.status === "succeeded" ||
        payload.status === "failed" ||
        payload.status === "interrupted"
      );
    default:
      return false;
  }
};

const parseEvent = (
  line: string,
  expectedSessionId: string,
  expectedSeq: number,
  expectedTurnId: string | undefined,
  requestId: string,
  inputId: string,
): TurnStreamEvent => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new InvalidTurnEventError("TiDB Link returned malformed NDJSON", {
      requestId,
      inputId,
      ...(expectedTurnId ? { turnId: expectedTurnId } : {}),
    });
  }
  if (
    !isRecord(value) ||
    typeof value.event !== "string" ||
    (expectedSeq === 0 ? value.event !== "turn_started" : value.event === "turn_started") ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    value.sessionId !== expectedSessionId ||
    (expectedTurnId !== undefined && value.turnId !== expectedTurnId) ||
    value.seq !== expectedSeq ||
    typeof value.createdAt !== "string" ||
    (value.agentRunId !== undefined && typeof value.agentRunId !== "string") ||
    !isRecord(value.payload) ||
    !validPayload(value.event, value.payload) ||
    (value.event === "turn_started" && value.payload.inputId !== inputId)
  ) {
    throw new InvalidTurnEventError("TiDB Link returned an invalid Turn event", {
      requestId,
      inputId,
      ...(expectedTurnId ? { turnId: expectedTurnId } : {}),
    });
  }
  return value as TurnStreamEvent;
};

export const decodeInteraction = (
  value: unknown,
  identity: { requestId?: string; inputId?: string; kind?: "message" | "cancel"; turnId?: string } = {},
): Interaction => {
  const invalid = () => new OutcomeUnknownError("TiDB Link returned an invalid saved interaction", identity);
  if (!isRecord(value) ||
    typeof value.inputId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.inputId) ||
    (identity.inputId !== undefined && value.inputId !== identity.inputId) ||
    !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
    !oneOf(value.kind, ["message", "cancel"]) || (identity.kind !== undefined && value.kind !== identity.kind) ||
    !oneOf(value.mode, ["started", "steered", "cancelled", "rejected"]) ||
    typeof value.turnId !== "string" || !value.turnId || (identity.turnId !== undefined && value.turnId !== identity.turnId) ||
    typeof value.createdAt !== "string" || !(value.appliedAt === null || typeof value.appliedAt === "string") ||
    !isRecord(value.result) || !oneOf(value.result.status, ["running", "succeeded", "failed", "interrupted"]) ||
    !(value.result.completedAt === null || typeof value.result.completedAt === "string")) throw invalid();
  if (value.mode === "rejected") {
    if (!isRecord(value.rejection) || !oneOf(value.rejection.code, ["interaction_admission_closed", "interaction_target_conflict"])) throw invalid();
  } else if (value.rejection !== null || (value.kind === "cancel" ? value.mode !== "cancelled" : !oneOf(value.mode, ["started", "steered"]))) throw invalid();
  if (value.message !== null && (!isRecord(value.message) || typeof value.message.id !== "string" || !value.message.id || value.message.role !== "user" || typeof value.message.content !== "string" || typeof value.message.createdAt !== "string")) throw invalid();
  if ((value.kind === "cancel" && value.message !== null) || (oneOf(value.mode, ["started", "steered"]) && value.message === null)) throw invalid();
  return {
    inputId: value.inputId,
    sequence: value.sequence as number,
    kind: value.kind,
    mode: value.mode,
    turnId: value.turnId,
    message: value.message === null ? null : { id: (value.message as Record<string, string>).id!, role: "user", content: (value.message as Record<string, string>).content!, createdAt: (value.message as Record<string, string>).createdAt! },
    createdAt: value.createdAt,
    appliedAt: value.appliedAt as string | null,
    rejection: value.rejection === null ? null : { code: (value.rejection as { code: "interaction_admission_closed" | "interaction_target_conflict" }).code },
    result: { status: value.result.status, completedAt: value.result.completedAt as string | null },
  };
};

const receiptFrom = async (opened: HttpStream, inputId: string, kind: "message" | "cancel", turnId?: string): Promise<InteractionReceipt> => {
  const identity = { requestId: opened.requestId, inputId, ...(turnId === undefined ? {} : { turnId }) };
  const contentType = opened.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (![200, 202].includes(opened.response.status) || contentType !== "application/json") {
    await opened.response.body?.cancel().catch(() => undefined);
    throw new OutcomeUnknownError("TiDB Link returned an invalid input response protocol", identity);
  }
  let value: unknown;
  try { value = await opened.response.json(); } catch { throw new OutcomeUnknownError("TiDB Link returned an invalid input receipt", identity); }
  const saved = decodeInteraction(isRecord(value) ? value.interaction : undefined, { ...identity, kind });
  if (opened.response.status === 202 && saved.mode !== (kind === "cancel" ? "cancelled" : "steered")) throw new OutcomeUnknownError("TiDB Link returned an invalid input admission mode", identity);
  return { type: "receipt", replayed: opened.response.status === 200, interaction: saved };
};

const bodyFor = (input: CreateTurnInput): Record<string, unknown> => {
  requireKnownKeys(
    input,
    ["inputId", "text", "userFileIds", "clarificationSourceTurnId", "billingTag", "requestId", "signal"],
    "Turn input",
  );
  requireStableIdentity(input.inputId, "inputId");
  const textIsValid =
    (typeof input.text === "string" && input.text.length > 0) || strings(input.text, 1, 9);
  if (!textIsValid) throw new TypeError("text must contain 1-9 non-empty values");
  if (
    input.userFileIds !== undefined &&
    (!strings(input.userFileIds, 0, 20) || input.userFileIds.some((id) => id.length > 64))
  ) {
    throw new TypeError("userFileIds must contain at most 20 non-empty ids");
  }
  if (
    input.clarificationSourceTurnId !== undefined &&
    (typeof input.clarificationSourceTurnId !== "string" ||
      input.clarificationSourceTurnId.length === 0 ||
      input.clarificationSourceTurnId.length > 64)
  ) {
    throw new TypeError("clarificationSourceTurnId must contain 1-64 characters");
  }
  return {
    inputId: input.inputId,
    input: {
      type: "text",
      text: input.text,
      ...(input.userFileIds === undefined ? {} : { userFileIds: input.userFileIds }),
    },
    ...(input.clarificationSourceTurnId === undefined
      ? {}
      : { clarificationSourceTurnId: input.clarificationSourceTurnId }),
    ...(input.billingTag === undefined ? {} : { billingTag: input.billingTag }),
  };
};

export async function* streamTurn(
  http: HttpClient,
  sessionId: string,
  input: CreateTurnInput,
): AsyncGenerator<TurnStreamItem> {
  const opened = await http.openStream(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    bodyFor(input),
    {
      inputId: input.inputId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const contentType = opened.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (opened.response.status !== 201 || contentType !== "application/x-ndjson") {
    yield await receiptFrom(opened, input.inputId, "message");
    return;
  }
  if (!opened.response.body) throw new OutcomeUnknownError("TiDB Link omitted the execution stream", { requestId: opened.requestId, inputId: input.inputId });
  const reader = opened.response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let expectedSeq = 0;
  let turnId: string | undefined;
  let sourceDone = false;
  let terminalSeen = false;

  const lineEvent = (line: string): TurnStreamEvent => {
    if (terminalSeen) throw new InvalidTurnEventError("TiDB Link returned events after Turn completion", { requestId: opened.requestId, inputId: input.inputId, ...(turnId ? { turnId } : {}) });
    const parsed = parseEvent(line, sessionId, expectedSeq, turnId, opened.requestId, input.inputId);
    turnId ??= parsed.turnId;
    expectedSeq += 1;
    terminalSeen = parsed.event === "turn_finished";
    return parsed;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        sourceDone = true;
        buffer += decoder.decode();
        if (buffer.trim()) {
          const parsed = lineEvent(buffer.trim());
          yield parsed;

        }
        if (terminalSeen) return;
        throw new OutcomeUnknownError("Turn stream ended without a terminal event", {
          requestId: opened.requestId,
          inputId: input.inputId,
          ...(turnId ? { turnId } : {}),
        });
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const parsed = lineEvent(line);
          yield parsed;

        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (cause) {
    if (cause instanceof TiDBLinkError) throw cause;
    throw new OutcomeUnknownError("Turn stream was interrupted before its terminal event", {
      requestId: opened.requestId,
      inputId: input.inputId,
      ...(turnId ? { turnId } : {}),
      cause,
    });
  } finally {
    if (!sourceDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const stopTurn = async (http: HttpClient, sessionId: string, turnId: string, input: StopTurnInput): Promise<InteractionReceipt> => {
  requireKnownKeys(input, ["inputId", "requestId", "signal"], "Stop input");
  requireStableIdentity(input.inputId, "inputId");
  if (typeof turnId !== "string" || !turnId) throw new TypeError("Turn id is required");
  const opened = await http.openStream(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stop`, { inputId: input.inputId }, { inputId: input.inputId, turnId, ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...(input.signal ? { signal: input.signal } : {}) });
  return receiptFrom(opened, input.inputId, "cancel", turnId);
};

export const collectTurn = async (
  http: HttpClient,
  sessionId: string,
  input: CreateTurnInput,
): Promise<TurnResult> => {
  let message: Extract<TurnStreamEvent, { event: "assistant_message" }>["payload"] | undefined;
  let knownError: Extract<TurnStreamEvent, { event: "turn_error" }>["payload"] | undefined;
  let terminal: Extract<TurnStreamEvent, { event: "turn_finished" }> | undefined;
  for await (const item of streamTurn(http, sessionId, input)) {
    if ("type" in item) return item;
    if (item.event === "assistant_message") message = item.payload;
    if (item.event === "turn_error") knownError = item.payload;
    if (item.event === "turn_finished") terminal = item;
  }
  if (!terminal) throw new OutcomeUnknownError("Turn omitted its terminal event", { inputId: input.inputId });
  if (terminal.payload.status === "failed") throw new TurnFailedError({ turnId: terminal.turnId, code: knownError?.code ?? "turn_failed", message: knownError?.message ?? "Turn failed" });
  if (terminal.payload.status === "interrupted") throw new TurnInterruptedError(terminal.turnId, knownError?.message);
  if (!message) throw new InvalidTurnEventError("Successful Turn omitted its assistant message", { inputId: input.inputId, turnId: terminal.turnId });
  return message.clarificationItem
    ? { type: "clarification", turnId: terminal.turnId, messageId: message.messageId, text: message.text, clarification: message.clarificationItem }
    : { type: "answer", turnId: terminal.turnId, messageId: message.messageId, text: message.text };
};
