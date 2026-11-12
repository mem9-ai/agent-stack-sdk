import type { TemplateSwitchStatus } from "./template-switch.js";
import { TiDBLinkError } from "./errors.js";
import type { ClarificationItem } from "./session.js";
import type { RealtimeResponseKind, SessionRealtimeEvent } from "./history.js";

/**
 * One event of a Session's event stream. Events whose `type` the SDK does not
 * know are delivered unchanged; use `asKnownSessionEvent` for typed access.
 * Display events remain provisional; use the original interaction to
 * establish a result.
 */
export interface SessionEvent {
  /** Opaque stream position. Persist it to resume after this event. */
  cursor: string;
  type: string;
  sessionId: string;
  turnId: string | null;
  createdAt: string;
  data: Record<string, unknown>;
}

/** The durable Turn event carried in `data` of every `agent.session.turn.*` event. */
export interface TurnEventData<Name extends string, Payload> {
  event: Name;
  turnId: string;
  sessionId: string;
  agentRunId?: string;
  seq: number;
  createdAt: string;
  payload: Payload;
}

interface KnownEvent<Type extends string, Data> extends SessionEvent {
  type: Type;
  data: Data & Record<string, unknown>;
}

export type TurnStartedEvent = KnownEvent<
  "agent.session.turn.started",
  TurnEventData<"turn_started", { inputId?: string; execution?: { model: string } }>
> & { turnId: string };

/** The complete provisional draft; replace the previous draft of this Turn. */
export type TurnDraftEvent = KnownEvent<
  "agent.session.turn.output_text.snapshot",
  TurnEventData<"assistant_draft", { text: string }>
> & { turnId: string };

export type TurnProgressEvent = KnownEvent<
  "agent.session.turn.progress",
  TurnEventData<"progress", { text: string }>
> & { turnId: string };

export interface OperationStepPayload {
  operationId: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "unknown_result";
  label: string;
  category?: "tool_call" | "skill_read";
  skill?: { skillId: string; name: string };
  source?: { type: "session_client" } | { type: string; [field: string]: unknown };
}

export type TurnItemAddedEvent = KnownEvent<
  "agent.session.turn.item.added",
  | TurnEventData<
      "assistant_message",
      { messageId: string; text: string; clarificationItem?: ClarificationItem }
    >
  | TurnEventData<"operation_step", OperationStepPayload>
> & { turnId: string };

/** A Client Tool call carried by `agent.session.turn.requires_action`. */
export interface ClientToolCallPayload {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  deadlineAt: string;
}

export type TurnRequiresActionEvent = KnownEvent<
  "agent.session.turn.requires_action",
  TurnEventData<"client_tool_calls", { calls: ClientToolCallPayload[] }>
> & { turnId: string };

export type TurnCompletedEvent = KnownEvent<
  "agent.session.turn.completed",
  TurnEventData<"turn_finished", { status: "succeeded" }>
> & { turnId: string };

export type TurnCancelledEvent = KnownEvent<
  "agent.session.turn.cancelled",
  TurnEventData<"turn_finished", { status: "interrupted" }>
> & { turnId: string };

export type TurnFailedEvent = KnownEvent<
  "agent.session.turn.failed",
  | TurnEventData<"turn_finished", { status: "failed" }>
  | TurnEventData<
      "turn_error",
      { code: string; message: string; details?: Record<string, unknown> }
    >
> & { turnId: string };

export type RealtimeTranscriptEvent = KnownEvent<
  "agent.session.realtime.input_transcript.completed",
  Extract<SessionRealtimeEvent, { type: "input_transcript" }>
>;

export type RealtimeResponseEvent = KnownEvent<
  "agent.session.realtime.response.completed",
  Extract<SessionRealtimeEvent, { type: "response" }> & {
    kind: RealtimeResponseKind;
  }
>;

export interface TemplateSwitchEventData {
  id: string;
  commandId: string;
  status: Extract<TemplateSwitchStatus, "succeeded" | "failed">;
  configurationEpoch: number;
  agentTemplateId: string;
  contentDigest: string | null;
  createdAt: string;
}

export type TemplateSwitchEvent = KnownEvent<
  "agent.session.template_switch.succeeded" | "agent.session.template_switch.failed",
  TemplateSwitchEventData
>;

export type KnownSessionEvent =
  | TurnStartedEvent
  | TurnDraftEvent
  | TurnProgressEvent
  | TurnItemAddedEvent
  | TurnRequiresActionEvent
  | TurnCompletedEvent
  | TurnCancelledEvent
  | TurnFailedEvent
  | RealtimeTranscriptEvent
  | RealtimeResponseEvent
  | TemplateSwitchEvent;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string =>
  typeof value === "string";

/** Turn events name their durable event in `data.event`. */
const TURN_EVENTS: Record<string, readonly string[]> = {
  "agent.session.turn.started": ["turn_started"],
  "agent.session.turn.output_text.snapshot": ["assistant_draft"],
  "agent.session.turn.progress": ["progress"],
  "agent.session.turn.item.added": ["assistant_message", "operation_step"],
  "agent.session.turn.requires_action": ["client_tool_calls"],
  "agent.session.turn.completed": ["turn_finished"],
  "agent.session.turn.cancelled": ["turn_finished"],
  "agent.session.turn.failed": ["turn_finished", "turn_error"],
};
const FINISHED_STATUS: Record<string, string> = {
  "agent.session.turn.completed": "succeeded",
  "agent.session.turn.cancelled": "interrupted",
  "agent.session.turn.failed": "failed",
};

const isTextPayload = (payload: Record<string, unknown>) =>
  isString(payload.text);

const isKnownTurnPayload = (
  name: string,
  payload: Record<string, unknown>,
  type: string,
): boolean => {
  switch (name) {
    case "progress":
    case "assistant_draft":
      return isTextPayload(payload);
    case "assistant_message":
      return isTextPayload(payload) && isString(payload.messageId);
    case "operation_step":
      return (
        isString(payload.operationId) &&
        isString(payload.status) &&
        isString(payload.label)
      );
    case "client_tool_calls":
      return (
        Array.isArray(payload.calls) &&
        payload.calls.every(
          (call) =>
            isObject(call) &&
            isString(call.callId) &&
            isString(call.name) &&
            isObject(call.arguments) &&
            isString(call.deadlineAt),
        )
      );
    case "turn_finished":
      return payload.status === FINISHED_STATUS[type];
    case "turn_error":
      return isString(payload.code) && isString(payload.message);
    default:
      return true;
  }
};

/**
 * Narrow an event to one of the types the SDK knows. Returns `undefined` for
 * any other type, and for a known type whose data lacks the fields the SDK
 * types; such events are still delivered by the stream unchanged.
 */
export function asKnownSessionEvent(
  event: SessionEvent,
): KnownSessionEvent | undefined {
  const { type, data } = event;
  const turnEvents = TURN_EVENTS[type];
  if (turnEvents) {
    if (
      !isString(event.turnId) ||
      !isString(data.event) ||
      !turnEvents.includes(data.event) ||
      !isObject(data.payload) ||
      !isKnownTurnPayload(data.event, data.payload, type)
    )
      return undefined;
    return event as KnownSessionEvent;
  }
  if (
    type === "agent.session.realtime.input_transcript.completed" ||
    type === "agent.session.realtime.response.completed"
  ) {
    const expected =
      type === "agent.session.realtime.input_transcript.completed"
        ? "input_transcript"
        : "response";
    return data.type === expected &&
      isString(data.id) &&
      isString(data.text) &&
      isString(data.realtimeConnectionId)
      ? (event as KnownSessionEvent)
      : undefined;
  }
  if (
    type === "agent.session.template_switch.succeeded" ||
    type === "agent.session.template_switch.failed"
  )
    return isString(data.commandId) &&
      isString(data.agentTemplateId) &&
      typeof data.configurationEpoch === "number" &&
      data.status === type.slice("agent.session.template_switch.".length)
      ? (event as KnownSessionEvent)
      : undefined;
  return undefined;
}

/**
 * Parse one Server-Sent Events frame of a Session event stream: its `id`
 * (the cursor) and `data` (the JSON envelope). Use it when you receive the
 * frames yourself, for example when forwarding a stream. Throws a
 * TiDBLinkError for a malformed envelope.
 */
export function parseSessionEvent(
  frame: { id: string; data: string },
  options: { sessionId?: string; requestId?: string } = {},
): SessionEvent {
  const requestId =
    options.requestId === undefined ? {} : { requestId: options.requestId };
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch (cause) {
    throw new TiDBLinkError("Session event data is not valid JSON", {
      ...requestId,
      cause,
    });
  }
  const event = value as Partial<SessionEvent> | null;
  if (
    !isString(frame.id) ||
    !frame.id ||
    !isObject(event) ||
    !isString(event.type) ||
    !event.type ||
    !isString(event.sessionId) ||
    (options.sessionId !== undefined && event.sessionId !== options.sessionId) ||
    (event.turnId !== null && !isString(event.turnId)) ||
    !isString(event.createdAt) ||
    !isObject(event.data)
  )
    throw new TiDBLinkError("Session event has an invalid envelope", requestId);
  return { ...(event as Omit<SessionEvent, "cursor">), cursor: frame.id };
}
