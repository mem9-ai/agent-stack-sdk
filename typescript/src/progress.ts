import { getInteraction } from "./history.js";
import { waitForResult, validateWaitOptions, type TurnResult } from "./turn.js";
import {
  ConnectionError,
  StreamIdleError,
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
import { parseSessionEvent, type SessionEvent } from "./events.js";

export type { SessionEvent } from "./events.js";

/** Three keep-alive intervals of the service (15 seconds each). */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

export interface SessionEventsOptions extends RequestOptions {
  /** Opaque position from a previously received event. No automatic replay on refusal. */
  cursor?: string;
  /**
   * End the stream with a StreamIdleError when no bytes, not even a
   * keep-alive, arrive for this long. Time spent in your own code between
   * events does not count. Default 45 seconds; 0 disables the check.
   */
  idleTimeoutMs?: number;
}

export async function* sessionEvents(
  http: HttpClient,
  sessionId: string,
  options: SessionEventsOptions = {},
): AsyncGenerator<SessionEvent> {
  requireKnownKeys(
    options,
    ["cursor", "signal", "requestId", "idleTimeoutMs"],
    "Event subscription options",
  );
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || !options.cursor)
  )
    throw new TypeError("cursor must be a non-empty opaque event position");
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0)
    throw new TypeError("idleTimeoutMs must be a non-negative integer");
  const query = new URLSearchParams({ stream: "true" });
  if (options.cursor !== undefined) query.set("cursor", options.cursor);

  const idle = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, idle.signal])
    : idle.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pause = () => clearTimeout(timer);
  const arm = () => {
    pause();
    if (idleTimeoutMs > 0) timer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };
  let cursor = options.cursor;
  let requestId = options.requestId;
  const silent = (cause: unknown) =>
    idle.signal.aborted && !options.signal?.aborted
      ? new StreamIdleError({
          idleTimeoutMs,
          ...(cursor ? { cursor } : {}),
          ...(requestId ? { requestId } : {}),
        })
      : cause;

  let frames: AsyncGenerator<{ id: string; data: string }> | undefined;
  arm();
  try {
    let response: Response;
    try {
      ({ response, requestId } = await http.rawResponse(
        `/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
        {
          headers: { accept: "text/event-stream" },
          signal,
          ...(options.requestId ? { requestId: options.requestId } : {}),
        },
      ));
    } catch (cause) {
      throw silent(cause);
    }
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
    frames = decodeSse(response.body, arm);
    while (true) {
      let next: IteratorResult<{ id: string; data: string }>;
      try {
        next = await frames.next();
      } catch (cause) {
        if (signal.aborted) throw silent(cause);
        throw new ConnectionError("Session event stream was interrupted", {
          ...(requestId ? { requestId } : {}),
          cause,
        });
      }
      if (next.done) return;
      const event = parseSessionEvent(next.value, {
        sessionId,
        ...(requestId ? { requestId } : {}),
      });
      cursor = event.cursor;
      // Time spent by the consumer is not silence on the connection.
      pause();
      yield event;
      arm();
    }
  } finally {
    pause();
    // Release the connection when the consumer stops early.
    await frames?.return(undefined);
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
    ["cursor", "signal", "requestId", "timeoutMs", "idleTimeoutMs"],
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
    if (receipt.kind !== "message" && receipt.kind !== "retry")
      throw new TiDBLinkError(
        "Turn observation requires a message or checkpoint retry receipt",
      );
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
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
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
        // Replayed terminal events may belong to another execution of this Turn.
        const current = await getInteraction(http, sessionId, inputId, request);
        if (current.result.status === "running") continue;
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
