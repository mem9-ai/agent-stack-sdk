import type {
  AttachResult,
  AttachmentEnd,
  BackendConnectionPool,
  BackendLink,
  PoolAttachment,
} from "./backend-pool.js";
import {
  validateClientTools,
  type ClientToolDeclaration,
} from "./client-tools.js";
import { ClientToolExecutor } from "./client-tool-executor.js";
import { TiDBLinkApiError, TiDBLinkError } from "./errors.js";
import {
  asKnownSessionEvent,
  sessionEventFrom,
  type RealtimeResponseEvent,
  type RealtimeTranscriptEvent,
  type SessionEvent,
} from "./events.js";
import { HttpClient, requestOptions, requireKnownKeys } from "./http.js";
import {
  requireOpenRealtimeConnectionReceipt,
  requireRealtimeConnectGrantReceipt,
  type OpenRealtimeConnectionInput,
  type RealtimeConnectGrant,
} from "./realtime.js";
import {
  sendOverConnection,
  type EventWatch,
  type SendOptions,
} from "./session-send.js";
import type { TurnResult } from "./turn.js";

/** What a Client Tool handler learns about the call it runs. */
export interface ClientToolCallContext {
  callId: string;
  sessionId: string;
  userId: string;
  turnId: string;
  /** The tool's name. */
  name: string;
  /** Submit the result before this time; the core then reports the effect as unknown. */
  deadlineAt: Date;
  /** Aborts when the deadline passes. */
  signal: AbortSignal;
}

/**
 * One Client Tool: its declaration, which the model sees, and the function
 * that executes it, usually by forwarding the call to a device.
 */
export interface ClientToolHandler {
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /**
   * Execute one call. Return the text the model receives; other values are
   * sent as JSON. Throw to report a failure, whose message the model sees.
   */
  run(
    args: Record<string, unknown>,
    context: ClientToolCallContext,
  ): unknown;
}

export type ClientToolHandlers = Record<string, ClientToolHandler>;

/** A completed Realtime user transcript. */
export type RealtimeTranscript = RealtimeTranscriptEvent["data"];
/** A completed Realtime model response. */
export type RealtimeResponse = RealtimeResponseEvent["data"];

export interface ConnectOptions {
  /**
   * The Session's Client Tools by name. Each attach replaces the Session's
   * whole Client Tool set with these declarations, and this connection
   * executes their calls. Omit to keep the stored set unchanged.
   */
  tools?: ClientToolHandlers;
  /**
   * Receive events only, while another connection executes the Session's
   * Client Tools. An observing connection never takes the Session from an
   * executing one and cannot declare tools.
   */
  observe?: boolean;
  /**
   * Resume after this event: the cursor of the last event you processed,
   * saved through `onCursor`. Without it, delivery starts after the
   * Session's latest event and history is not replayed.
   */
  cursor?: string;
  /** Called after each event's callbacks complete, with its cursor. Persist it to resume. */
  onCursor?: (cursor: string) => void | Promise<void>;
  /** Every event of the Session, in order, including types the SDK does not know. */
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Each completed Realtime user transcript. */
  onTranscript?: (transcript: RealtimeTranscript) => void | Promise<void>;
  /** Each completed Realtime model response. */
  onResponse?: (response: RealtimeResponse) => void | Promise<void>;
  /**
   * Errors that do not end the connection: a callback that threw, an
   * invalid event, a tool result the core did not accept. Without it they
   * are rethrown asynchronously, which by default ends a Node.js process.
   */
  onError?: (error: unknown) => void;
}

/** Why a Session connection ended. */
export type SessionConnectionEnd =
  /** `close()` or `OrganizationClient.close()`. */
  | { reason: "closed" }
  /** Another connection attached the Session for execution. */
  | { reason: "superseded" }
  /** The Session was deleted. */
  | { reason: "session_deleted" }
  /** The connection could not be restored, for example after the Organization API Key was revoked. */
  | { reason: "error"; error: unknown };

const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** Whether `cursor` is at or before `last`; opaque cursors never compare. */
const notAfter = (cursor: string, last: string | undefined): boolean =>
  last !== undefined &&
  DECIMAL.test(cursor) &&
  DECIMAL.test(last) &&
  BigInt(cursor) <= BigInt(last);

/**
 * A Session attached over this process's Backend Connections. It receives
 * the Session's events, in order and without gaps, across reconnects and
 * replica moves, until `close()` or until `closed` reports why it ended.
 */
export class SessionConnection {
  readonly sessionId: string;
  readonly userId: string;
  /** Resolves once, with why the connection ended. */
  readonly closed: Promise<SessionConnectionEnd>;

  readonly #pool: BackendConnectionPool;
  readonly #http: HttpClient;
  readonly #options: ConnectOptions;
  readonly #declarations: ClientToolDeclaration[] | undefined;
  readonly #attachment: PoolAttachment;
  #cursor: string | undefined;
  #generation: number | undefined;
  #link: BackendLink | undefined;
  #ended: SessionConnectionEnd | undefined;
  #settle!: (end: SessionConnectionEnd) => void;
  #queue: Promise<void> = Promise.resolve();
  readonly #executor: ClientToolExecutor | undefined;
  /** Waiting for the next attach, or for the end. */
  #linkWaiters: { resolve: () => void }[] = [];
  /** Event buffers of `send()` calls in flight. */
  readonly #watchers = new Set<{ events: SessionEvent[]; wake: () => void }>();

  /** @internal Use `session.connect()`. */
  constructor(
    pool: BackendConnectionPool,
    http: HttpClient,
    userId: string,
    sessionId: string,
    options: ConnectOptions,
    declarations: ClientToolDeclaration[] | undefined,
  ) {
    this.#pool = pool;
    this.#http = http;
    this.userId = userId;
    this.sessionId = sessionId;
    this.#options = options;
    this.#declarations = declarations;
    this.#cursor = options.cursor;
    this.closed = new Promise((resolve) => {
      this.#settle = resolve;
    });
    // An executing connection runs the Session's calls, declared here or not.
    this.#executor = options.observe
      ? undefined
      : new ClientToolExecutor({
          pool,
          sessionId,
          handlers: options.tools ?? {},
          report: (error) => this.#report(error),
        });
    this.#attachment = {
      sessionId,
      attachParams: () => this.#attachParams(),
      attached: (result, link) => this.#attached(result, link),
      notify: (method, params, link) => this.#notify(method, params, link),
      ended: (end) => this.#end(end),
    };
  }

  /**
   * Cursor of the last event whose callbacks completed, or the Session's
   * position when the connection attached if none has arrived since.
   */
  get cursor(): string | undefined {
    return this.#cursor;
  }

  /** The Session's attachment generation from the latest attach. */
  get generation(): number | undefined {
    return this.#generation;
  }

  /**
   * Release the Session. Events stop, and calls published later go to no one
   * until another connection attaches. Calls already running finish and
   * their results are still submitted.
   */
  async close(): Promise<void> {
    if (this.#ended) return;
    this.#end({ reason: "closed" });
    await this.#pool.detach(this.#attachment);
  }

  /**
   * Send a user message over the connection and wait for the Turn it starts,
   * or the active Turn it steers. `onProgress` receives the assistant's draft
   * from the pushed events; the result is read once the Turn finished, with
   * the same shape and errors as `session.turn()`. A message whose answer was
   * lost to a reconnect is sent again with the same `clientEventId`, which
   * the core deduplicates.
   */
  send(
    text: string | [string, ...string[]],
    options?: SendOptions,
  ): Promise<TurnResult> {
    return sendOverConnection(
      {
        sessionId: this.sessionId,
        http: this.#http,
        closed: this.closed,
        link: (signal, after) => this.#nextLink(signal, after),
        report: (error) => this.#report(error),
        watch: () => this.#watch(),
      },
      text,
      options,
    );
  }

  /**
   * Prepare the Session's Realtime connection and return what a device needs
   * to join it directly: the WebSocket URL and a short-lived connect token.
   * When a Realtime connection is already live, a new token for it is
   * returned instead and `audio` is not applied.
   */
  async realtimeGrant(
    input: OpenRealtimeConnectionInput = {},
    options?: { signal?: AbortSignal },
  ): Promise<RealtimeConnectGrant> {
    requireKnownKeys(input, ["audio", "metadata"], "Realtime grant input");
    const request = requestOptions(options);
    const path = `/sessions/${encodeURIComponent(this.sessionId)}/realtime`;
    try {
      const result = await this.#http.postResponse<unknown>(path, input, {
        ...request,
        outcomeUnknown: true,
      });
      const opened = requireOpenRealtimeConnectionReceipt(result.data, result.requestId);
      return {
        websocketUrl: opened.websocketUrl,
        connectToken: opened.connectToken,
        connectTokenExpiresAt: opened.connectTokenExpiresAt,
      };
    } catch (error) {
      if (!(error instanceof TiDBLinkApiError) || error.code !== "realtime_connection_live")
        throw error;
    }
    const result = await this.#http.postResponse<unknown>(`${path}/connect-tokens`, undefined, {
      ...request,
      outcomeUnknown: true,
    });
    return requireRealtimeConnectGrantReceipt(result.data, result.requestId);
  }

  /** @internal */
  async attach(): Promise<void> {
    await this.#pool.attach(this.#attachment);
  }

  #report(error: unknown): void {
    if (this.#options.onError) {
      try {
        this.#options.onError(error);
        return;
      } catch (thrown) {
        error = thrown;
      }
    }
    queueMicrotask(() => {
      throw error;
    });
  }

  #attachParams(): Record<string, unknown> {
    return {
      userId: this.userId,
      sessionId: this.sessionId,
      ...(this.#options.observe ? { kind: "observing" } : {}),
      ...(this.#declarations ? { tools: this.#declarations } : {}),
      ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
    };
  }

  #attached(result: AttachResult, link: BackendLink): void {
    this.#link = link;
    this.#generation = result.generation;
    // Without a resume point, delivery starts after the attach position.
    this.#cursor ??= result.cursor;
    this.#wakeLinkWaiters();
  }

  #wakeLinkWaiters(): void {
    const waiters = this.#linkWaiters;
    this.#linkWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /** The open link holding the attachment, other than `after`; waits for a re-attach. */
  async #nextLink(signal: AbortSignal, after?: BackendLink): Promise<BackendLink> {
    for (;;) {
      signal.throwIfAborted();
      if (this.#ended)
        throw new TiDBLinkError(
          `The Session connection ended (${this.#ended.reason}); connect again to send`,
        );
      const link = this.#link;
      if (link && link.open && link !== after) return link;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        this.#linkWaiters.push({
          resolve: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        });
        // A link that closed without a re-attach yet: look again shortly.
        if (link && !link.open) setTimeout(() => this.#wakeLinkWaiters(), 100);
      });
    }
  }

  #watch(): EventWatch {
    const watcher = { events: [] as SessionEvent[], wake: () => undefined as void };
    this.#watchers.add(watcher);
    return {
      next: async (signal) => {
        for (;;) {
          const event = watcher.events.shift();
          if (event) return event;
          if (this.#ended) return undefined;
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            watcher.wake = () => {
              signal.removeEventListener("abort", onAbort);
              watcher.wake = () => undefined;
              resolve();
            };
          });
        }
      },
      stop: () => {
        this.#watchers.delete(watcher);
      },
    };
  }

  #notify(method: string, params: Record<string, unknown>, link: BackendLink): void {
    if (this.#ended) return;
    if (method === "tool.call") {
      this.#executor?.receive(params, link);
      return;
    }
    if (method !== "session.event") return;
    let event: SessionEvent;
    try {
      event = sessionEventFrom(params.event, params.cursor, {
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.#queue = this.#queue.then(() => this.#report(error));
      return;
    }
    // One event at a time, so that callbacks and saved cursors follow the Session's order.
    this.#queue = this.#queue.then(() => this.#deliver(event));
  }

  async #deliver(event: SessionEvent): Promise<void> {
    // A re-attach replays from the last completed event; skip what already ran.
    if (this.#ended || notAfter(event.cursor, this.#cursor)) return;
    const options = this.#options;
    await this.#run(() => options.onEvent?.(event));
    const known = asKnownSessionEvent(event);
    if (known?.type === "agent.session.realtime.input_transcript.completed")
      await this.#run(() => options.onTranscript?.(known.data));
    if (known?.type === "agent.session.realtime.response.completed")
      await this.#run(() => options.onResponse?.(known.data));
    this.#cursor = event.cursor;
    for (const watcher of this.#watchers) {
      watcher.events.push(event);
      watcher.wake();
    }
    await this.#run(() => options.onCursor?.(event.cursor));
  }

  async #run(callback: () => unknown): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.#report(error);
    }
  }

  #end(end: AttachmentEnd | SessionConnectionEnd): void {
    if (this.#ended) return;
    this.#ended = end;
    this.#link = undefined;
    this.#settle(end);
    this.#wakeLinkWaiters();
    for (const watcher of this.#watchers) watcher.wake();
  }
}

/** Check `connect()` options and turn tool handlers into declarations. */
export function connectDeclarations(
  options: ConnectOptions,
): ClientToolDeclaration[] | undefined {
  requireKnownKeys(
    options,
    ["tools", "observe", "cursor", "onCursor", "onEvent", "onTranscript", "onResponse", "onError"],
    "Session connection options",
  );
  for (const key of ["onCursor", "onEvent", "onTranscript", "onResponse", "onError"] as const)
    if (options[key] !== undefined && typeof options[key] !== "function")
      throw new TypeError(`${key} must be a function`);
  if (options.observe !== undefined && typeof options.observe !== "boolean")
    throw new TypeError("observe must be a boolean");
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || !/^(0|[1-9][0-9]{0,14})$/.test(options.cursor))
  )
    throw new TypeError("cursor must be an event cursor received from this Session");
  if (options.tools === undefined) return undefined;
  if (options.observe)
    throw new TypeError("An observing connection cannot declare Client Tools");
  if (typeof options.tools !== "object" || options.tools === null || Array.isArray(options.tools))
    throw new TypeError("tools must map each Client Tool name to its handler");
  const declarations = Object.entries(options.tools).map(([name, handler]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new TypeError(
        `Client Tool name ${JSON.stringify(name)} must be 1-64 letters, digits, _ or -`,
      );
    requireKnownKeys(handler, ["description", "parameters", "run"], `Client Tool ${name}`);
    if (typeof handler.run !== "function")
      throw new TypeError(`Client Tool ${name} requires a run function`);
    return {
      type: "function" as const,
      name,
      description: handler.description,
      parameters: handler.parameters,
    };
  });
  validateClientTools(declarations);
  return declarations;
}

/** Open a Session connection; resolves once the first attach took effect. */
export async function connectSession(
  http: HttpClient,
  pool: BackendConnectionPool | undefined,
  userId: string | undefined,
  sessionId: string,
  options: ConnectOptions = {},
): Promise<SessionConnection> {
  if (!pool || !userId)
    throw new TiDBLinkError(
      "connect() needs a Session selected through OrganizationClient.user(userId)",
    );
  const declarations = connectDeclarations(options);
  const connection = new SessionConnection(pool, http, userId, sessionId, options, declarations);
  await connection.attach();
  return connection;
}
