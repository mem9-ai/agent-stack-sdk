import { getInteraction } from "./history.js";
import { waitForResult, validateWaitOptions, type TurnResult } from "./turn.js";
import {
  TiDBLinkError,
  TiDBLinkApiError,
  TurnFailedError,
  TurnInterruptedError,
  InputNotAppliedError,
  ObservationStoppedError,
} from "./errors.js";
import { HttpClient, requireKnownKeys, requireCreationKey } from "./http.js";
import type { RequestOptions } from "./organization.js";
import { decodeSse } from "./sse.js";

export interface SessionEventsOptions extends RequestOptions {
  /** Opaque position from a previously received event. No automatic replay on refusal. */
  cursor?: string;
}

/** Display events remain provisional; use the original interaction to establish its result. */
export interface SessionEvent {
  cursor: string;
  type: string;
  sessionId: string;
  turnId: string | null;
  createdAt: string;
  data: Record<string, unknown>;
}

export async function* sessionEvents(
  http: HttpClient,
  sessionId: string,
  options: SessionEventsOptions = {},
): AsyncGenerator<SessionEvent> {
  requireKnownKeys(
    options,
    ["cursor", "signal", "requestId"],
    "Event subscription options",
  );
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || !options.cursor)
  )
    throw new TypeError("cursor must be a non-empty opaque event position");
  const query = new URLSearchParams({ stream: "true" });
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const { response, requestId } = await http.rawResponse(
    `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
    {
      headers: { accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    },
  );
  if (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "text/event-stream" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new TiDBLinkError("Session subscription returned no event stream", {
      requestId,
    });
  }
  for await (const frame of decodeSse(response.body)) {
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch (cause) {
      throw new TiDBLinkError(
        "Session subscription returned invalid event JSON",
        { requestId, cause },
      );
    }
    const event = value as Partial<SessionEvent> | null;
    if (
      !frame.id ||
      !event ||
      typeof event.type !== "string" ||
      !event.type ||
      event.sessionId !== sessionId ||
      (event.turnId !== null && typeof event.turnId !== "string") ||
      typeof event.createdAt !== "string" ||
      typeof event.data !== "object" ||
      event.data === null ||
      Array.isArray(event.data)
    )
      throw new TiDBLinkError(
        "Session subscription returned an invalid event envelope",
        { requestId },
      );
    yield { ...event, cursor: frame.id } as SessionEvent;
  }
}

export interface ObserveTurnOptions extends SessionEventsOptions {
  /** Local observation deadline only; default 60 seconds. */
  timeoutMs?: number;
}

export type TurnObservation =
  | { type: "draft" | "progress"; text: string; event: SessionEvent }
  | { type: "event"; event: SessionEvent }
  | { type: "result"; result: TurnResult };

export async function* observeTurn(
  http: HttpClient,
  sessionId: string,
  inputId: string,
  options: ObserveTurnOptions = {},
): AsyncGenerator<TurnObservation> {
  requireKnownKeys(
    options,
    ["cursor", "signal", "requestId", "timeoutMs"],
    "Turn observation options",
  );
  requireCreationKey(inputId);
  const { timeoutMs } = validateWaitOptions(
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const request = {
    signal,
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
  let cursor = options.cursor;
  let turnId: string | undefined;
  try {
    const receipt = await getInteraction(http, sessionId, inputId, request);
    turnId = receipt.turnId;
    if (receipt.kind !== "message")
      throw new TiDBLinkError("Turn observation requires a message receipt");
    if (
      receipt.rejection ||
      receipt.mode === "rejected" ||
      receipt.result.status !== "running"
    ) {
      yield {
        type: "result",
        result: await waitForResult(http, sessionId, inputId, {
          ...request,
          timeoutMs,
        }),
      };
      return;
    }
    for await (const event of sessionEvents(http, sessionId, {
      ...request,
      ...(cursor ? { cursor } : {}),
    })) {
      cursor = event.cursor;
      if (event.turnId !== turnId) continue;
      const payload = event.data.payload;
      if (
        event.type === "agent.session.turn.output_text.snapshot" ||
        event.type === "agent.session.turn.progress"
      ) {
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof (payload as { text?: unknown }).text !== "string"
        )
          throw new TiDBLinkError(
            "Session text event omitted its complete text",
          );
        yield {
          type:
            event.type === "agent.session.turn.output_text.snapshot"
              ? "draft"
              : "progress",
          text: (payload as { text: string }).text,
          event,
        };
      } else yield { type: "event", event };
      if (
        event.data.event === "turn_finished" ||
        event.data.event === "turn_error"
      ) {
        // A terminal event can belong to a newer retry; the original receipt remains authoritative.
        yield {
          type: "result",
          result: await waitForResult(http, sessionId, inputId, {
            ...request,
            timeoutMs,
          }),
        };
        return;
      }
    }
    throw new TiDBLinkError(
      "Session event subscription ended before the original result was established",
    );
  } catch (cause) {
    if (
      cause instanceof TiDBLinkApiError ||
      cause instanceof TurnFailedError ||
      cause instanceof TurnInterruptedError ||
      cause instanceof InputNotAppliedError
    )
      throw cause;
    throw new ObservationStoppedError(
      deadline.signal.aborted && !options.signal?.aborted
        ? "Local observation timed out; recover the original input"
        : "Observation stopped; recover the original input",
      {
        sessionId,
        inputId,
        ...(turnId ? { turnId } : {}),
        ...(cursor ? { cursor } : {}),
        ...(cause instanceof TiDBLinkError && cause.requestId
          ? { requestId: cause.requestId }
          : options.requestId
            ? { requestId: options.requestId }
            : {}),
        timedOut: deadline.signal.aborted && !options.signal?.aborted,
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
