import {
  BackendConnectionClosedError,
  BackendRequestError,
  TiDBLinkError,
} from "./errors.js";

/**
 * One Backend Connection (ADR 0109): a WebSocket from this Application Server
 * process to the core, carrying one JSON-RPC 2.0 message per text frame.
 * The published definition is the core's `docs/backend-connection-v1.schema.json`.
 */
export const BACKEND_CONNECTION_PATH = "/api/v1/org/backend/ws";
export const BACKEND_CONNECTION_SUBPROTOCOL = "tidb-link.backend.v1";

/** The part of the WHATWG WebSocket the SDK uses. */
export interface BackendWebSocket {
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

/**
 * A WebSocket constructor that accepts upgrade headers, like Node.js's
 * global `WebSocket` (undici). The SDK sends the Organization API Key in the
 * `Authorization` header, never in the URL.
 */
export type WebSocketConstructor = new (
  url: string,
  // Node.js accepts `{ protocols, headers }`; typed loosely so that the DOM
  // `WebSocket` declaration, whose second parameter is `protocols`, fits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init: any,
) => BackendWebSocket;

/** Connection parameters the core announces in `hello`. */
export interface BackendConnectionHello {
  connectionId: string;
  /** Most Session Attachments this connection may hold. */
  maxSessions: number;
  /** How long a published Client Tool call waits for its claim. */
  claimWindowMs: number;
  /** Interval of the core's WebSocket pings. */
  heartbeatMs: number;
  /** Largest frame the core accepts. */
  maxFrameBytes: number;
}

export type BackendNotificationHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

export interface OpenBackendTransportInput {
  /** `ws:` or `wss:` URL of the Backend Connection route. */
  url: string;
  apiKey: string;
  WebSocket?: WebSocketConstructor | undefined;
  /** Receives every core notification after `hello`, in arrival order. */
  onNotification: BackendNotificationHandler;
  /** Give up when `hello` has not arrived by then. Default 15 seconds. */
  openTimeoutMs?: number;
}

/** Close code the SDK uses when the core stopped answering liveness probes. */
export const CLIENT_HEARTBEAT_CLOSE = 4000;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
/** Bounds the liveness interval whatever `hello.heartbeatMs` says. */
const MIN_PROBE_INTERVAL_MS = 1_000;
const MAX_PROBE_INTERVAL_MS = 60_000;

const encoder = new TextEncoder();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const parseHello = (params: unknown): BackendConnectionHello | undefined => {
  if (!isObject(params)) return undefined;
  const { connectionId, maxSessions, claimWindowMs, heartbeatMs, maxFrameBytes } =
    params;
  if (
    typeof connectionId !== "string" ||
    !connectionId ||
    !isPositiveInteger(maxSessions) ||
    !isPositiveInteger(claimWindowMs) ||
    !isPositiveInteger(heartbeatMs) ||
    !isPositiveInteger(maxFrameBytes)
  )
    return undefined;
  return { connectionId, maxSessions, claimWindowMs, heartbeatMs, maxFrameBytes };
};

/** Derive the Backend Connection URL from the SDK's HTTP(S) base URL. */
export const backendConnectionUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${url.toString().replace(/\/$/, "")}${BACKEND_CONNECTION_PATH}`;
};

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * One open Backend Connection: JSON-RPC request and response pairing,
 * notifications, liveness and close. It never reconnects; the connection
 * pool replaces a closed transport.
 *
 * Liveness: the core pings at the WebSocket layer, which the WHATWG
 * WebSocket answers but does not expose. So when nothing has arrived for one
 * heartbeat interval, the transport sends a `ping` request; any answer, even
 * "method not found", proves the connection alive. With no frame for a
 * further interval it closes the connection.
 */
export class BackendTransport {
  readonly hello: BackendConnectionHello;
  /** Resolves once with why the connection ended, local closes included. */
  readonly closed: Promise<BackendConnectionClosedError>;

  readonly #socket: BackendWebSocket;
  readonly #pending = new Map<number, PendingRequest>();
  #onNotification: BackendNotificationHandler;
  #nextId = 1;
  #lastFrameAt = performance.now();
  #probing = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #error: BackendConnectionClosedError | undefined;
  #settleClosed!: (error: BackendConnectionClosedError) => void;

  private constructor(
    socket: BackendWebSocket,
    hello: BackendConnectionHello,
    onNotification: BackendNotificationHandler,
  ) {
    this.#socket = socket;
    this.hello = hello;
    this.#onNotification = onNotification;
    this.closed = new Promise((resolve) => {
      this.#settleClosed = resolve;
    });
    const interval = Math.min(
      MAX_PROBE_INTERVAL_MS,
      Math.max(MIN_PROBE_INTERVAL_MS, hello.heartbeatMs),
    );
    this.#timer = setInterval(() => this.#checkLiveness(interval), interval);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Open a connection and wait for the core's `hello`. */
  static open(input: OpenBackendTransportInput): Promise<BackendTransport> {
    const WebSocketClass =
      input.WebSocket ??
      (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (typeof WebSocketClass !== "function")
      throw new TypeError(
        "Backend Connections need a WebSocket constructor; pass the WebSocket option",
      );
    const timeoutMs = input.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let transport: BackendTransport | undefined;
      let settled = false;
      const fail = (error: BackendConnectionClosedError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      let socket: BackendWebSocket;
      try {
        socket = new WebSocketClass(input.url, {
          protocols: [BACKEND_CONNECTION_SUBPROTOCOL],
          headers: { authorization: `Bearer ${input.apiKey}` },
        });
      } catch (cause) {
        reject(
          new BackendConnectionClosedError({
            code: 1006,
            message: "Could not open a Backend Connection",
            cause,
          }),
        );
        return;
      }
      const timer = setTimeout(() => {
        fail(
          new BackendConnectionClosedError({
            code: 1006,
            message: `Backend Connection sent no hello within ${timeoutMs} ms`,
          }),
        );
        closeQuietly(socket, 1000);
      }, timeoutMs);
      socket.addEventListener("message", ({ data }) => {
        if (transport) return transport.#receive(data);
        const message = typeof data === "string" ? safeParse(data) : undefined;
        const hello =
          message?.method === "hello" && !("id" in message)
            ? parseHello(message.params)
            : undefined;
        if (!hello) {
          fail(
            new BackendConnectionClosedError({
              code: 1002,
              message: "Backend Connection did not start with a valid hello",
            }),
          );
          closeQuietly(socket, 1002);
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transport = new BackendTransport(socket, hello, input.onNotification);
        resolve(transport);
      });
      socket.addEventListener("close", ({ code, reason }) => {
        const error = new BackendConnectionClosedError({ code, reason });
        if (transport) transport.#end(error);
        else fail(error);
      });
      // Once open, an error is followed by close, which carries the code. A
      // refused upgrade may report only the error (Node.js 22).
      socket.addEventListener("error", (event) => {
        if (transport) return;
        fail(
          new BackendConnectionClosedError({
            code: 1006,
            message: "Could not open a Backend Connection",
            cause: (event as { error?: unknown }).error ?? event,
          }),
        );
        closeQuietly(socket, 1000);
      });
    });
  }

  /** Whether requests can still be sent. */
  get open(): boolean {
    return this.#error === undefined;
  }

  /** Requests sent and not yet answered. */
  get pendingRequests(): number {
    return this.#pending.size;
  }

  /**
   * Send a request and wait for its answer. A JSON-RPC error rejects with a
   * BackendRequestError; a connection that ends first rejects with its
   * BackendConnectionClosedError, and the request's outcome is then unknown.
   */
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.#error) return Promise.reject(this.#error);
    const id = this.#nextId++;
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (encoder.encode(text).byteLength > this.hello.maxFrameBytes)
      return Promise.reject(
        new TiDBLinkError(
          `${method} exceeds the Backend Connection frame limit of ${this.hello.maxFrameBytes} bytes`,
        ),
      );
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.#socket.send(text);
      } catch (cause) {
        this.#pending.delete(id);
        reject(
          new BackendConnectionClosedError({
            code: 1006,
            message: "Could not send on the Backend Connection",
            cause,
          }),
        );
      }
    });
  }

  /** Close the connection. Pending requests reject at once. */
  close(code = 1000, reason = ""): void {
    if (this.#error) return;
    this.#end(
      new BackendConnectionClosedError({
        code,
        reason,
        message: reason || "Backend Connection closed by this process",
      }),
    );
    closeQuietly(this.#socket, code, reason);
  }

  #receive(data: unknown): void {
    if (this.#error) return;
    this.#lastFrameAt = performance.now();
    this.#probing = false;
    const message = typeof data === "string" ? safeParse(data) : undefined;
    if (!message || message.jsonrpc !== "2.0") {
      this.close(1002, "invalid frame");
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message) {
        // The core sends no requests in this protocol revision.
        this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      this.#onNotification(
        message.method,
        isObject(message.params) ? message.params : {},
      );
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (isObject(message.error)) {
      const { code, message: text, data } = message.error;
      const reason = isObject(data) && typeof data.reason === "string" ? data.reason : undefined;
      pending.reject(
        new BackendRequestError({
          code: typeof code === "number" ? code : -32603,
          message: typeof text === "string" && text ? text : "Backend Connection request failed",
          ...(reason === undefined ? {} : { reason }),
          ...(isObject(data) && "details" in data ? { details: data.details } : {}),
        }),
      );
    } else pending.resolve(message.result);
  }

  #checkLiveness(interval: number): void {
    if (this.#error) return;
    if (performance.now() - this.#lastFrameAt < interval) return;
    if (this.#probing) {
      this.#end(
        new BackendConnectionClosedError({
          code: CLIENT_HEARTBEAT_CLOSE,
          message: `Backend Connection was silent for ${2 * interval} ms`,
        }),
      );
      closeQuietly(this.#socket, CLIENT_HEARTBEAT_CLOSE, "heartbeat timeout");
      return;
    }
    this.#probing = true;
    // Any answer, including "method not found" from a core without `ping`, counts.
    this.request("ping", {}).catch(() => undefined);
  }

  #send(message: unknown): void {
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      // The close event follows.
    }
  }

  #end(error: BackendConnectionClosedError): void {
    if (this.#error) return;
    this.#error = error;
    clearInterval(this.#timer);
    this.#onNotification = () => undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#settleClosed(error);
  }
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function closeQuietly(socket: BackendWebSocket, code: number, reason = ""): void {
  try {
    // A client may only send 1000 or an application code in 3000-4999.
    socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
  } catch {
    // Already closing.
  }
}
