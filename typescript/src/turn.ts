import {
  AgentStackError,
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
} from "./errors.js";
import { HttpClient } from "./http.js";
import type { ClarificationItem } from "./session.js";

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
        execution?: {
          backend: "pi" | "codex";
          model: string;
          modelReasoningEffort: "low" | "medium" | "high" | "xhigh" | null;
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
      "agent_run_step",
      {
        parentAgentRunId: string;
        runOrdinal: number;
        role: "subagent";
        depth: 1;
        status: "running" | "succeeded" | "failed" | "timed_out" | "interrupted";
        displayLabel: string;
      }
    >
  | TurnEvent<
      "assistant_message",
      { messageId: string; text: string; clarificationItem?: ClarificationItem }
    >
  | TurnEvent<"turn_error", { code: string; message: string }>
  | TurnEvent<"turn_finished", { status: "succeeded" | "failed" | "interrupted" }>;

export interface CreateTurnInput {
  text: string | [string, ...string[]];
  userFileIds?: string[];
  outputSchema?: { type: "object"; [key: string]: unknown };
  clarificationSourceTurnId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export type TurnResult =
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
    !strings(value.answerChoices, 2, 8)
  ) {
    return false;
  }
  if (
    value.selectionMode !== undefined &&
    value.selectionMode !== "single" &&
    value.selectionMode !== "multiple"
  ) {
    return false;
  }
  if (value.response === undefined) return true;
  return (
    isRecord(value.response) &&
    typeof value.response.text === "string" &&
    typeof value.response.responseTurnId === "string" &&
    (value.response.answers === undefined || strings(value.response.answers, 1))
  );
};

const validPayload = (event: string, payload: Record<string, unknown>): boolean => {
  switch (event) {
    case "turn_started": {
      if (payload.execution === undefined) return true;
      const execution = payload.execution;
      return (
        isRecord(execution) &&
        oneOf(execution.backend, ["pi", "codex"]) &&
        typeof execution.model === "string" &&
        (execution.modelReasoningEffort === null ||
          oneOf(execution.modelReasoningEffort, ["low", "medium", "high", "xhigh"]))
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
    case "agent_run_step":
      return (
        typeof payload.parentAgentRunId === "string" &&
        payload.parentAgentRunId.length > 0 &&
        Number.isInteger(payload.runOrdinal) &&
        payload.role === "subagent" &&
        payload.depth === 1 &&
        oneOf(payload.status, ["running", "succeeded", "failed", "timed_out", "interrupted"]) &&
        typeof payload.displayLabel === "string"
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
): TurnStreamEvent => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new InvalidTurnEventError("Agent Service returned malformed NDJSON", {
      requestId,
      ...(expectedTurnId ? { turnId: expectedTurnId } : {}),
      cause,
    });
  }
  if (
    !isRecord(value) ||
    typeof value.event !== "string" ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    value.sessionId !== expectedSessionId ||
    (expectedTurnId !== undefined && value.turnId !== expectedTurnId) ||
    value.seq !== expectedSeq ||
    typeof value.createdAt !== "string" ||
    (value.agentRunId !== undefined && typeof value.agentRunId !== "string") ||
    !isRecord(value.payload) ||
    !validPayload(value.event, value.payload)
  ) {
    throw new InvalidTurnEventError("Agent Service returned an invalid Turn event", {
      requestId,
      ...(expectedTurnId ? { turnId: expectedTurnId } : {}),
    });
  }
  return value as TurnStreamEvent;
};

const bodyFor = (input: CreateTurnInput): Record<string, unknown> => {
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
    input.outputSchema !== undefined &&
    (!isRecord(input.outputSchema) ||
      input.outputSchema.type !== "object" ||
      new TextEncoder().encode(JSON.stringify(input.outputSchema)).byteLength > 65_536)
  ) {
    throw new TypeError("outputSchema must be an object schema no larger than 65536 UTF-8 bytes");
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
    input: {
      type: "text",
      text: input.text,
      ...(input.userFileIds === undefined ? {} : { userFileIds: input.userFileIds }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    },
    ...(input.clarificationSourceTurnId === undefined
      ? {}
      : { clarificationSourceTurnId: input.clarificationSourceTurnId }),
  };
};

export async function* streamTurn(
  http: HttpClient,
  sessionId: string,
  input: CreateTurnInput,
): AsyncGenerator<TurnStreamEvent> {
  const opened = await http.openStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    bodyFor(input),
    {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const reader = opened.response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let expectedSeq = 0;
  let turnId: string | undefined;
  let sourceDone = false;

  const lineEvent = (line: string): TurnStreamEvent => {
    const parsed = parseEvent(line, sessionId, expectedSeq, turnId, opened.requestId);
    turnId ??= parsed.turnId;
    expectedSeq += 1;
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
          if (parsed.event === "turn_finished") return;
        }
        throw new OutcomeUnknownError("Turn stream ended without a terminal event", {
          requestId: opened.requestId,
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
          if (parsed.event === "turn_finished") return;
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (cause) {
    if (input.signal?.aborted) throw input.signal.reason ?? cause;
    if (cause instanceof AgentStackError) throw cause;
    throw new OutcomeUnknownError("Turn stream was interrupted before its terminal event", {
      requestId: opened.requestId,
      ...(turnId ? { turnId } : {}),
      cause,
    });
  } finally {
    if (!sourceDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const collectTurn = async (
  http: HttpClient,
  sessionId: string,
  input: CreateTurnInput,
): Promise<TurnResult> => {
  let message:
    | Extract<TurnStreamEvent, { event: "assistant_message" }>["payload"]
    | undefined;
  let knownError: Extract<TurnStreamEvent, { event: "turn_error" }>["payload"] | undefined;
  for await (const event of streamTurn(http, sessionId, input)) {
    if (event.event === "assistant_message") message = event.payload;
    if (event.event === "turn_error") knownError = event.payload;
    if (event.event !== "turn_finished") continue;
    if (event.payload.status === "failed") {
      throw new TurnFailedError({
        turnId: event.turnId,
        code: knownError?.code ?? "turn_failed",
        message: knownError?.message ?? "Turn failed",
      });
    }
    if (event.payload.status === "interrupted") {
      throw new TurnInterruptedError(event.turnId, knownError?.message);
    }
    if (!message) {
      throw new InvalidTurnEventError("Successful Turn omitted its assistant message");
    }
    return message.clarificationItem
      ? {
          type: "clarification",
          turnId: event.turnId,
          messageId: message.messageId,
          text: message.text,
          clarification: message.clarificationItem,
        }
      : {
          type: "answer",
          turnId: event.turnId,
          messageId: message.messageId,
          text: message.text,
        };
  }
  throw new Error("unreachable");
};
