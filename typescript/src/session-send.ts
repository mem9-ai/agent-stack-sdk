import type { BackendLink } from "./backend-pool.js";
import {
  BackendConnectionClosedError,
  BackendRequestError,
  InputNotAppliedError,
  OutcomeUnknownError,
  TiDBLinkError,
  TurnWaitTimeoutError,
} from "./errors.js";
import type { SessionEvent } from "./events.js";
import { requireInteraction, type SessionInteraction } from "./history.js";
import { HttpClient, requireCreationKey, requireKnownKeys, sleep } from "./http.js";
import type { BillingTag } from "./session.js";
import {
  validateMessageData,
  validateWaitOptions,
  waitForResult,
  type MessageData,
  type TurnResult,
} from "./turn.js";

export interface SendOptions {
  /**
   * Stable identity of this message in the Session's command namespace,
   * shared with REST. Persist it before sending to recover the result after a
   * crash with `session.waitForResult(clientEventId)`. Default: a random UUID.
   */
  clientEventId?: string;
  userFileIds?: string[];
  clarificationSourceTurnId?: string;
  billingTag?: BillingTag | null;
  /**
   * The assistant's draft so far, each time it grows. Each call carries the
   * complete draft: replace what you showed, do not append.
   */
  onProgress?: (draft: string) => void;
  /** Local deadline for the whole call; default 60 seconds. Never cancels the Turn. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What `send()` needs from its Session connection. */
export interface SendChannel {
  readonly sessionId: string;
  readonly http: HttpClient;
  /** The link that holds the attachment now, or the next one; rejects once the connection ended. */
  link(signal: AbortSignal, after?: BackendLink): Promise<BackendLink>;
  /** Resolves when the connection ends. */
  readonly closed: Promise<unknown>;
  /** Report an error that does not end the call. */
  report(error: unknown): void;
  /** Start buffering this connection's events, in delivery order. */
  watch(): EventWatch;
}

export interface EventWatch {
  /** The next event, or `undefined` once the connection ended. */
  next(signal: AbortSignal): Promise<SessionEvent | undefined>;
  stop(): void;
}

const aborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Refusals after which the same message may go out on the next link. */
const MOVE_ON = new Set(["connection_draining", "session_not_attached"]);

const isAmbiguous = (error: unknown): boolean =>
  error instanceof BackendConnectionClosedError ||
  (error instanceof BackendRequestError && error.code === -32603);

/**
 * Submit a user message over the connection and wait for the Turn it starts
 * or steers: progress from the pushed events, and the result read once the
 * Turn's terminal event arrives.
 */
export async function sendOverConnection(
  channel: SendChannel,
  text: string | [string, ...string[]],
  options: SendOptions = {},
): Promise<TurnResult> {
  requireKnownKeys(
    options,
    [
      "clientEventId",
      "userFileIds",
      "clarificationSourceTurnId",
      "billingTag",
      "onProgress",
      "timeoutMs",
      "signal",
    ],
    "Send options",
  );
  const { clientEventId = crypto.randomUUID(), onProgress, timeoutMs, signal } = options;
  requireCreationKey(clientEventId);
  if (onProgress !== undefined && typeof onProgress !== "function")
    throw new TypeError("onProgress must be a function");
  const data: MessageData = {
    text,
    ...(options.userFileIds === undefined ? {} : { userFileIds: options.userFileIds }),
    ...(options.clarificationSourceTurnId === undefined
      ? {}
      : { clarificationSourceTurnId: options.clarificationSourceTurnId }),
    ...(options.billingTag === undefined ? {} : { billingTag: options.billingTag }),
  };
  validateMessageData(data);
  const { timeoutMs: limit } = validateWaitOptions(
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(limit);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { sessionId } = channel;
  // Events of the Turn may arrive before the receipt.
  const watch = channel.watch();
  let receipt: SessionInteraction | undefined;
  let ambiguous = false;
  try {
    receipt = await submit();
    if (receipt.rejection || receipt.mode === "rejected")
      throw new InputNotAppliedError(sessionId, clientEventId, receipt.turnId);
    if (receipt.result.status === "running") await untilFinished(receipt.turnId);
  } catch (error) {
    if (error instanceof InputNotAppliedError || error instanceof BackendRequestError)
      throw error;
    // Nothing reached the core: the error is definite.
    if (receipt === undefined && !ambiguous) throw error;
    const ErrorClass =
      deadline.aborted && !signal?.aborted ? TurnWaitTimeoutError : OutcomeUnknownError;
    throw new ErrorClass(
      receipt === undefined
        ? "The message's outcome is unknown; recover it with session.waitForResult(clientEventId)"
        : "Local wait stopped before the Turn finished; query or wait for the original input",
      {
        sessionId,
        inputId: clientEventId,
        ...(receipt ? { turnId: receipt.turnId } : {}),
        cause: error,
      },
    );
  } finally {
    watch.stop();
  }
  // The terminal event arrived (or the connection ended): read the settled result.
  return waitForResult(channel.http, sessionId, clientEventId, {
    timeoutMs: Math.max(0, limit - (Date.now() - startedAt)),
    pollIntervalMs: 100,
    ...(signal ? { signal } : {}),
  });

  async function submit(): Promise<SessionInteraction> {
    let link: BackendLink | undefined;
    for (;;) {
      link = await channel.link(stop, link);
      let result: unknown;
      try {
        result = await Promise.race([
          link.request("session.send", { sessionId, clientEventId, data }),
          aborted(stop),
          // Ended while the answer was outstanding: the core may have accepted it.
          channel.closed.then(() => {
            throw new BackendConnectionClosedError({
              code: 1000,
              message: "The Session connection ended before the message's answer arrived",
            });
          }),
        ]);
      } catch (error) {
        if (isAmbiguous(error)) {
          // The core may have accepted it; the same clientEventId replays the receipt.
          ambiguous = true;
          if (error instanceof BackendRequestError) {
            // An internal error on a live connection: try the same one again shortly.
            await Promise.race([sleep(200), aborted(stop)]);
            link = undefined;
          }
          continue;
        }
        if (error instanceof BackendRequestError && MOVE_ON.has(error.reason ?? ""))
          continue;
        throw error;
      }
      const interaction = (result as { interaction?: unknown } | undefined)?.interaction;
      const parsed = requireInteraction(interaction, clientEventId, undefined);
      if (parsed.kind !== "message" || !parsed.message || parsed.message.role !== "user")
        throw new TiDBLinkError("session.send returned a different command receipt");
      return parsed;
    }
  }

  async function untilFinished(turnId: string): Promise<void> {
    for (;;) {
      const event = await watch.next(stop);
      // The connection ended; the REST read below still establishes the result.
      if (!event) return;
      if (event.turnId !== turnId) continue;
      const payload = event.data as { event?: unknown; payload?: { text?: unknown } };
      if (
        event.type === "agent.session.turn.output_text.snapshot" &&
        typeof payload.payload?.text === "string"
      ) {
        try {
          onProgress?.(payload.payload.text);
        } catch (error) {
          // A failing display callback does not change the Turn.
          channel.report(error);
        }
      }
      if (payload.event === "turn_finished") return;
    }
  }
}
