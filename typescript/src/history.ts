import { TiDBLinkError } from "./errors.js";
import {
  HttpClient,
  requireKnownKeys,
  paginationQuery,
  type ListOptions,
} from "./http.js";
import type { RequestOptions } from "./organization.js";
import type { BillingTag, ClarificationItem } from "./session.js";

export type TurnStatus = "running" | "succeeded" | "failed" | "interrupted";
export type RealtimeResponseKind =
  | "chat"
  | "task_ack"
  | "task_progress"
  | "task_result"
  | "clarify"
  | "device_ack";

export type MessageInputContext =
  | { channel: "text" }
  | { channel: "standing_task" }
  | {
      channel: "audio";
      utterance?: string;
      emotion?: {
        label: string;
        confidence: number;
        source: "realtime_model";
      };
      realtimeSummary?: string;
    };

export type RealtimeMessageMetadata =
  | { startsTurn: boolean; linkedTurnId: string | null }
  | {
      kind: RealtimeResponseKind;
      interrupted: boolean;
      responseId: string | null;
      linkedTurnId: string | null;
    };

export interface MessageRecord {
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  inputContext?: MessageInputContext;
  realtime?: RealtimeMessageMetadata;
}

export interface TurnUserFile {
  turnId: string;
  sessionId: string;
  organizationId: string;
  userFileId: string;
  ordinal: number;
  originalName: string;
  safeName: string;
  drivePath: string;
  byteSize: number;
  sha256: string;
  checksumVerification: "whole" | "part_only" | null;
  contentType: string | null;
  createdAt: string;
}

export type OperationStatus = TurnStatus | "unknown_result";
export type OperationResultPointer =
  | { kind: "inline"; field: "output" }
  | {
      kind: "artifact";
      artifactId: string;
      mediaType: string;
      bytes: number;
      preview?: string;
    }
  | {
      kind: "published_artifact";
      artifactId: string;
      revisionId: string;
      mediaType: string;
      bytes: number;
      sha256: string;
      name: string;
    }
  | {
      kind: "chat_image";
      imageId: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      bytes: number;
      sha256: string;
      name: string;
      alt: string;
    };

export interface OperationRecord {
  id: string;
  sessionId: string;
  turnId: string;
  scope: {
    organizationId: string;
    sessionId: string;
    turnId: string;
    agentRunId: string;
  };
  kind:
    | "agent.respond"
    | "memory.recall"
    | "memory.list"
    | "memory.stage"
    | "memory.write"
    | "llm.complete"
    | "drive.commit"
    | "fs.read_file"
    | "fs.write_file"
    | "fs.list_dir"
    | "fs.stat"
    | "fs.mkdir"
    | "fs.delete"
    | "exec.run"
    | "web.search"
    | "session.history"
    | "hardware.state.read"
    | "artifact.get"
    | "artifact.publish"
    | "chat.image"
    | "schedule.create"
    | "schedule.update"
    | "schedule.list"
    | "schedule.cancel"
    | "external_tool.execute"
    | "client_tool.call";
  backend:
    | "internal_fixture"
    | "pi-agent-core"
    | "local"
    | "e2b"
    | "tencent_ags"
    | "run9"
    | "drive9"
    | "exa"
    | "mem9"
    | "azure_openai"
    | "mcp"
    | "client";
  targetKind:
    | "agent_runtime"
    | "llm"
    | "drive_fs"
    | "shell"
    | "sandbox"
    | "web"
    | "session"
    | "schedule"
    | "artifact"
    | "memory"
    | "external_tool"
    | "client_tool";
  mediator: "aos";
  status: OperationStatus;
  input: unknown;
  output?: unknown;
  resultPointer: OperationResultPointer;
  effectSummary?: {
    object: { kind: string; label: string; ref?: string | null };
    action: string;
    effectState: "confirmed" | "none" | "unknown";
    result: { status: OperationStatus; text: string };
    detail?: Record<string, unknown> | null;
    reversibility: {
      posture: "reversible" | "not_reversible" | "unknown";
      reason: string;
    };
    undo: {
      posture: "available" | "unavailable" | "verify_required";
      label: string | null;
      reason: string | null;
    };
  } | null;
  compensatesOperationId?: string | null;
  source?:
    | { type: "session_client" }
    | { type: "hardware"; hardwareRequirementId: string; method: string };
  label?: string;
  category?: "tool_call" | "skill_read";
  skill?: { skillId: string; name: string };
  createdAt: string;
  completedAt?: string;
}

export interface TurnFailure {
  code: string;
  message: string;
  details?: {
    reason?:
      | "model_provider_unconfigured"
      | "sandbox_unconfigured"
      | "drive9_unconfigured"
      | "drive9_disabled_for_organization";
    provider?: {
      category:
        | "authentication"
        | "supplier_error"
        | "supplier_unavailable"
        | "network"
        | "provider_stream_error";
      httpStatus: number | null;
      errorType: string | null;
      errorCode: string | null;
    };
  };
}

interface TurnRecordBase {
  id: string;
  sessionId: string;
  status: TurnStatus;
  billingTag: BillingTag | null;
  userMessages?: MessageRecord[];
  userFiles?: TurnUserFile[];
  operations: OperationRecord[];
  assistantMessage: MessageRecord | null;
  clarificationItem?: ClarificationItem;
  failure?: TurnFailure;
  realtimeResponses?: MessageRecord[];
  createdAt: string;
  completedAt?: string;
  sourceFireId?: string | null;
}

export interface FullAgentTurnRecord extends TurnRecordBase {
  executor?: "full_agent";
  userMessage: MessageRecord;
}

export interface RealtimeTurnRecord extends TurnRecordBase {
  executor: "realtime_model";
  userMessage: MessageRecord;
  realtime: { connectionId: string; linkedTurnIds: string[] };
}

export type TurnRecord = FullAgentTurnRecord | RealtimeTurnRecord;

export interface TurnPage {
  turns: TurnRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionInteraction {
  inputId: string;
  sequence: number;
  kind: "message" | "cancel" | "retry" | "client_tool_output";
  mode: "started" | "steered" | "cancelled" | "accepted" | "rejected";
  turnId: string;
  message: Pick<MessageRecord, "id" | "role" | "content" | "createdAt"> | null;
  createdAt: string;
  appliedAt: string | null;
  rejection: {
    code:
      | "interaction_admission_closed"
      | "interaction_target_conflict"
      | "client_tool_call_unavailable"
      | "client_tool_call_settled";
  } | null;
  result: { status: TurnStatus; completedAt: string | null };
}

export interface SessionInteractionPage {
  interactions: SessionInteraction[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type SessionRealtimeEvent = {
  id: string;
  realtimeConnectionId: string;
  text: string;
  turnId: string | null;
  createdAt: string;
} & (
  | { type: "input_transcript" }
  | {
      type: "response";
      responseId: string | null;
      kind: RealtimeResponseKind;
      interrupted: boolean;
    }
);

export type SessionTimelineEntry =
  | { type: "turn"; turn: TurnRecord }
  | { type: "realtime"; realtime: SessionRealtimeEvent };

export interface SessionTimelinePage {
  entries: SessionTimelineEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}

const sessionPath = (sessionId: string): string =>
  `/api/v1/user/sessions/${encodeURIComponent(sessionId)}`;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const allowed = (value: unknown, options: readonly string[]): boolean =>
  typeof value === "string" && options.includes(value);

export const requireInteraction = (
  value: unknown,
  inputId: string,
  requestId?: string,
): SessionInteraction => {
  if (
    !record(value) ||
    value.inputId !== inputId ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !allowed(value.kind, [
      "message",
      "cancel",
      "retry",
      "client_tool_output",
    ]) ||
    !allowed(value.mode, [
      "started",
      "steered",
      "cancelled",
      "accepted",
      "rejected",
    ]) ||
    !nonempty(value.turnId) ||
    typeof value.createdAt !== "string" ||
    !nullableText(value.appliedAt) ||
    !record(value.result) ||
    !allowed(value.result.status, [
      "running",
      "succeeded",
      "failed",
      "interrupted",
    ]) ||
    !nullableText(value.result.completedAt) ||
    !(
      value.message === null ||
      (record(value.message) &&
        nonempty(value.message.id) &&
        allowed(value.message.role, ["user", "assistant"]) &&
        typeof value.message.content === "string" &&
        typeof value.message.createdAt === "string")
    ) ||
    !(
      value.rejection === null ||
      (record(value.rejection) &&
        allowed(value.rejection.code, [
          "interaction_admission_closed",
          "interaction_target_conflict",
          "client_tool_call_unavailable",
          "client_tool_call_settled",
        ]))
    )
  ) {
    throw new TiDBLinkError(
      "TiDB Link returned an invalid interaction receipt",
      {
        ...(requestId ? { requestId } : {}),
      },
    );
  }
  return value as unknown as SessionInteraction;
};

export const listInteractions = (
  http: HttpClient,
  sessionId: string,
  options?: ListOptions,
): Promise<SessionInteractionPage> =>
  http.get(
    `${sessionPath(sessionId)}/interactions${paginationQuery(options)}`,
    options,
  );

export const getInteraction = async (
  http: HttpClient,
  sessionId: string,
  inputId: string,
  options?: RequestOptions,
): Promise<SessionInteraction> => {
  if (options)
    requireKnownKeys(options, ["requestId", "signal"], "Request options");
  const result = await http.getResponse<{ interaction?: unknown }>(
    `${sessionPath(sessionId)}/interactions/${encodeURIComponent(inputId)}`,
    options,
  );
  return requireInteraction(
    result.data?.interaction,
    inputId,
    result.requestId,
  );
};

export const reconcileInteraction = async (
  http: HttpClient,
  sessionId: string,
  clientEventId: string,
  options?: RequestOptions,
): Promise<SessionInteraction | null> => {
  const query = new URLSearchParams({ clientEventId });
  if (options)
    requireKnownKeys(options, ["requestId", "signal"], "Request options");
  const result = await http.getResponse<{ interactions?: unknown }>(
    `${sessionPath(sessionId)}/interactions?${query}`,
    options,
  );
  const values = result.data?.interactions;
  if (!Array.isArray(values) || values.length > 1)
    throw new TiDBLinkError(
      "TiDB Link returned an invalid interaction lookup",
      {
        requestId: result.requestId,
      },
    );
  return values.length
    ? requireInteraction(values[0], clientEventId, result.requestId)
    : null;
};

export const history = (
  http: HttpClient,
  sessionId: string,
  options?: ListOptions,
): Promise<TurnPage> =>
  http.get(
    `${sessionPath(sessionId)}/turns${paginationQuery(options)}`,
    options,
  );

export const getTurn = async (
  http: HttpClient,
  sessionId: string,
  turnId: string,
  options?: RequestOptions,
): Promise<TurnRecord> => {
  if (options)
    requireKnownKeys(options, ["requestId", "signal"], "Request options");
  const result = await http.getResponse<{ turn?: TurnRecord }>(
    `${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    options,
  );
  const turn = result.data?.turn;
  if (turn?.id !== turnId || turn.sessionId !== sessionId)
    throw new TiDBLinkError("TiDB Link returned a different Turn", {
      requestId: result.requestId,
    });
  return turn;
};

export const timeline = (
  http: HttpClient,
  sessionId: string,
  options?: ListOptions,
): Promise<SessionTimelinePage> =>
  http.get(
    `${sessionPath(sessionId)}/timeline${paginationQuery(options)}`,
    options,
  );
