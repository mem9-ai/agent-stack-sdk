import {
  listPendingClientToolCalls,
  type PendingClientToolCall,
} from "./client-tools.js";
import { ConnectionError, TiDBLinkApiError } from "./errors.js";
import { asKnownSessionEvent, type SessionEvent } from "./events.js";
import { HttpClient, requireKnownKeys, sleep } from "./http.js";
import type { RequestOptions } from "./organization.js";
import { sessionEvents } from "./progress.js";

export interface SubscribeOptions extends RequestOptions {
  /**
   * Resume after this event. Persist the cursor of each event you finish
   * handling; without one the service replays the Session from its start.
   */
  cursor?: string;
  /** See `SessionEventsOptions.idleTimeoutMs`. Default 45 seconds. */
  idleTimeoutMs?: number;
  /** Upper bound of the reconnect delay. Default 30 seconds. */
  maxReconnectDelayMs?: number;
}

export type SubscriptionItem =
  /** Every event of the stream, in order. */
  | { type: "event"; event: SessionEvent }
  /**
   * A Client Tool call that is still pending, delivered once per
   * subscription. Answer it with `session.submitClientToolOutput` before
   * `deadlineAt`.
   */
  | { type: "client_tool_call"; call: PendingClientToolCall }
  /** The connection dropped; the subscription reconnects after `retryInMs`. */
  | { type: "disconnected"; error: unknown; retryInMs: number };

/** Refusals that reconnecting cannot fix. */
const isFinal = (error: unknown): boolean =>
  error instanceof TiDBLinkApiError
    ? error.status < 500 && error.status !== 408 && error.status !== 429
    : !(error instanceof ConnectionError);

/**
 * Follow a Session's event stream until `signal` aborts. Reconnects from the
 * last cursor after network failures, server errors, silent connections and
 * normal stream ends, and stops with the error when the service refuses the
 * subscription (for example a revoked Key, a missing Session or a refused
 * cursor).
 *
 * Client Tool calls are delivered from the service's pending list, read on
 * every (re)connect and whenever a call event arrives. A call is delivered at
 * most once per subscription; calls replayed from history that are already
 * answered or past their deadline are not delivered.
 */
export async function* subscribe(
  http: HttpClient,
  sessionId: string,
  options: SubscribeOptions = {},
): AsyncGenerator<SubscriptionItem> {
  requireKnownKeys(
    options,
    ["cursor", "idleTimeoutMs", "maxReconnectDelayMs", "signal", "requestId"],
    "Subscription options",
  );
  const maxDelay = options.maxReconnectDelayMs ?? 30_000;
  if (!Number.isSafeInteger(maxDelay) || maxDelay < 0)
    throw new TypeError("maxReconnectDelayMs must be a non-negative integer");
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || !options.cursor)
  )
    throw new TypeError("cursor must be a non-empty opaque event position");
  const { signal } = options;
  const request = signal ? { signal } : {};
  const delivered = new Set<string>();
  let cursor = options.cursor;
  let failures = 0;

  async function* pendingCalls(
    only?: ReadonlySet<string>,
  ): AsyncGenerator<SubscriptionItem> {
    const calls = await listPendingClientToolCalls(http, sessionId, request);
    for (const call of calls) {
      if (delivered.has(call.callId) || (only && !only.has(call.callId)))
        continue;
      if (!(Date.parse(call.deadlineAt) > Date.now())) continue;
      delivered.add(call.callId);
      yield { type: "client_tool_call", call };
    }
  }

  while (!signal?.aborted) {
    let error: unknown;
    try {
      // Calls published before the cursor are not replayed by the stream.
      yield* pendingCalls();
      for await (const event of sessionEvents(http, sessionId, {
        ...request,
        ...(cursor ? { cursor } : {}),
        ...(options.idleTimeoutMs === undefined
          ? {}
          : { idleTimeoutMs: options.idleTimeoutMs }),
        ...(options.requestId ? { requestId: options.requestId } : {}),
      })) {
        failures = 0;
        cursor = event.cursor;
        yield { type: "event", event };
        const known = asKnownSessionEvent(event);
        if (known?.type === "agent.session.turn.requires_action") {
          const ids = new Set(
            known.data.payload.calls
              .map((call) => call.callId)
              .filter((id) => !delivered.has(id)),
          );
          if (ids.size) yield* pendingCalls(ids);
        }
      }
      error = new ConnectionError("Session event stream ended");
    } catch (cause) {
      if (signal?.aborted) return;
      if (isFinal(cause)) throw cause;
      error = cause;
    }
    failures += 1;
    const base = Math.min(maxDelay, 500 * 2 ** Math.min(failures - 1, 10));
    const retryInMs = Math.round(base / 2 + (Math.random() * base) / 2);
    yield { type: "disconnected", error, retryInMs };
    try {
      await sleep(retryInMs, signal);
    } catch {
      return;
    }
  }
}
