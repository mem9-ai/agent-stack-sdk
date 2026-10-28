import { HttpClient, requireKnownKeys } from "./http.js";
import {
  OutcomeUnknownError,
  TiDBLinkApiError,
  TurnFailedError,
  TurnInterruptedError,
  TiDBLinkError,
} from "./errors.js";
import { decodeSse } from "./sse.js";
import { validClarification } from "./turn.js";
import type { BillingTag, ClarificationItem } from "./session.js";
import type { OperationRecord, TurnFailure } from "./history.js";
import type { RequestOptions } from "./organization.js";

export interface AudioTurnInput extends RequestOptions {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
  /** Omit to inherit, null to clear the Session's default for this audio Turn. */
  billingTag?: BillingTag | null;
}

type AudioEnvelope<Name extends string, Payload> = {
  event: Name;
  sessionId: string;
  turnId: string;
  agentRunId?: string;
  seq: number;
  createdAt: string;
  payload: Payload;
};
export type AudioTurnEvent =
  | AudioEnvelope<
      "turn_started",
      { execution?: { model: string }; inputId?: string }
    >
  | AudioEnvelope<"progress", { text: string }>
  | AudioEnvelope<"assistant_draft", { text: string }>
  | AudioEnvelope<
      "operation_step",
      {
        operationId: string;
        status: OperationRecord["status"];
        label: string;
        category?: OperationRecord["category"];
        skill?: OperationRecord["skill"];
        source?: OperationRecord["source"];
      }
    >
  | AudioEnvelope<
      "assistant_message",
      { messageId: string; text: string; clarificationItem?: ClarificationItem }
    >
  | AudioEnvelope<"turn_error", TurnFailure>
  | AudioEnvelope<
      "turn_finished",
      { status: "succeeded" | "failed" | "interrupted" }
    >;
export type AudioTurnResult = {
  sessionId: string;
  turnId: string;
  messageId: string;
  text: string;
} & (
  | { type: "answer" }
  | { type: "clarification"; clarification: ClarificationItem }
);

/** Audio owns its response: losing or closing it may request remote interruption. */
export class AudioTurnStoppedError extends OutcomeUnknownError {
  constructor(
    sessionId: string,
    turnId?: string,
    requestId?: string,
    cause?: unknown,
  ) {
    super(
      "Audio response stopped before a confirmed terminal outcome; closing it may request interruption. Inspect saved history before submitting audio again.",
      {
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(cause ? { cause } : {}),
      },
    );
  }
}

const multipart = (
  input: AudioTurnInput,
): { body: Blob; contentType: string } => {
  requireKnownKeys(
    input,
    ["bytes", "filename", "contentType", "billingTag", "signal", "requestId"],
    "Audio input",
  );
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > 25 * 1024 * 1024
  )
    throw new TypeError("Audio requires 1 byte to 25 MiB of prerecorded data");
  if (
    typeof input.filename !== "string" ||
    !input.filename.trim() ||
    input.filename.length > 255
  )
    throw new TypeError("Audio requires a filename of 1-255 characters");
  const contentType = input.contentType ?? "application/octet-stream";
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType))
    throw new TypeError(
      "Audio contentType must be a media type without parameters",
    );
  const boundary = `tidb-link-audio-${crypto.randomUUID()}`;
  const filename = input.filename
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/"/g, "%22");
  const parts: BlobPart[] = [];
  if (input.billingTag !== undefined)
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="billingTag"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(input.billingTag)}\r\n`,
    );
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    Uint8Array.from(input.bytes),
    `\r\n--${boundary}--\r\n`,
  );
  return {
    body: new Blob(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

export async function* streamAudio(
  http: HttpClient,
  sessionId: string,
  input: AudioTurnInput,
): AsyncGenerator<AudioTurnEvent> {
  const upload = multipart(input);
  input.signal?.throwIfAborted();
  let turnId: string | undefined;
  let requestId: string | undefined;
  let sequence = -1;
  let response: Response | undefined;
  try {
    ({ response, requestId } = await http.rawResponse(
      `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/turns/audio`,
      {
        method: "POST",
        body: upload.body,
        headers: {
          accept: "text/event-stream",
          "content-type": upload.contentType,
        },
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
    ));
    if (
      response.status !== 201 ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "text/event-stream" ||
      !response.body
    )
      throw new TiDBLinkError("Audio response omitted its event stream");
    for await (const frame of decodeSse(response.body)) {
      const event = JSON.parse(frame.data) as AudioTurnEvent;
      if (
        !event ||
        event.sessionId !== sessionId ||
        typeof event.turnId !== "string" ||
        !event.turnId ||
        (turnId && event.turnId !== turnId) ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= sequence ||
        typeof event.createdAt !== "string" ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload) ||
        frame.event !== event.event ||
        ![
          "turn_started",
          "progress",
          "assistant_draft",
          "operation_step",
          "assistant_message",
          "turn_error",
          "turn_finished",
        ].includes(event.event)
      )
        throw new TiDBLinkError(
          "Audio response returned an invalid or mismatched event envelope",
        );
      turnId = event.turnId;
      sequence = event.seq;
      if (
        (event.event === "assistant_draft" || event.event === "progress") &&
        typeof event.payload.text !== "string"
      )
        throw new TiDBLinkError("Audio response returned invalid text");
      if (
        event.event === "assistant_message" &&
        (typeof event.payload.messageId !== "string" ||
          !event.payload.messageId ||
          typeof event.payload.text !== "string" ||
          (event.payload.clarificationItem !== undefined &&
            !validClarification(event.payload.clarificationItem)))
      )
        throw new TiDBLinkError(
          "Audio response returned an invalid final Message",
        );
      if (
        event.event === "turn_finished" &&
        !["succeeded", "failed", "interrupted"].includes(event.payload.status)
      )
        throw new TiDBLinkError(
          "Audio response returned an invalid terminal status",
        );
      yield event;
      if (event.event === "turn_finished") return;
    }
    throw new AudioTurnStoppedError(sessionId, turnId, requestId);
  } catch (cause) {
    if (
      cause instanceof TiDBLinkApiError ||
      cause instanceof AudioTurnStoppedError
    )
      throw cause;
    throw new AudioTurnStoppedError(
      sessionId,
      turnId,
      requestId ??
        (cause instanceof TiDBLinkError ? cause.requestId : input.requestId),
      cause,
    );
  } finally {
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => undefined);
  }
}

export async function audioTurn(
  http: HttpClient,
  sessionId: string,
  input: AudioTurnInput,
): Promise<AudioTurnResult> {
  let message:
    | Extract<AudioTurnEvent, { event: "assistant_message" }>
    | undefined;
  let failure: TurnFailure | undefined;
  for await (const event of streamAudio(http, sessionId, input)) {
    if (event.event === "assistant_message") message = event;
    if (event.event === "turn_error") failure = event.payload;
    if (event.event === "turn_finished") {
      if (event.payload.status === "failed")
        throw new TurnFailedError({
          sessionId,
          turnId: event.turnId,
          code: failure?.code ?? "turn_failed",
          message: failure?.message ?? "Audio Turn failed",
        });
      if (event.payload.status === "interrupted")
        throw new TurnInterruptedError(
          event.turnId,
          "Audio Turn was interrupted",
          sessionId,
        );
      if (!message) throw new AudioTurnStoppedError(sessionId, event.turnId);
      const identity = {
        sessionId,
        turnId: event.turnId,
        messageId: message.payload.messageId,
        text: message.payload.text,
      };
      return message.payload.clarificationItem
        ? {
            ...identity,
            type: "clarification",
            clarification: message.payload.clarificationItem,
          }
        : { ...identity, type: "answer" };
    }
  }
  throw new AudioTurnStoppedError(sessionId);
}
