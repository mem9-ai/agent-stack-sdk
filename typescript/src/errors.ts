export class TiDBLinkError extends Error {
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options?: { requestId?: string; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.requestId = options?.requestId;
  }
}

export class TiDBLinkApiError extends TiDBLinkError {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter: string | undefined;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
    retryAfter?: string;
  }) {
    super(
      input.message,
      input.requestId === undefined
        ? undefined
        : { requestId: input.requestId },
    );
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.retryAfter = input.retryAfter;
  }
}

export class ConflictError extends TiDBLinkApiError {}

export class ConnectionError extends TiDBLinkError {}

/** The request may have succeeded, so repeating it could create another effect. */
export class OutcomeUnknownError extends TiDBLinkError {
  readonly turnId: string | undefined;
  readonly sessionId: string | undefined;
  readonly inputId: string | undefined;

  constructor(
    message: string,
    options?: {
      requestId?: string;
      turnId?: string;
      sessionId?: string;
      inputId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.turnId = options?.turnId;
    this.sessionId = options?.sessionId;
    this.inputId = options?.inputId;
  }
}

export class TurnWaitTimeoutError extends OutcomeUnknownError {}

export class InputNotAppliedError extends TiDBLinkError {
  constructor(
    readonly sessionId: string,
    readonly inputId: string,
    readonly turnId: string,
  ) {
    super(
      "The original message was not incorporated; inspect its interaction receipt",
    );
  }
}

export class TurnFailedError extends TiDBLinkError {
  readonly code: string;
  readonly turnId: string;
  readonly sessionId: string | undefined;
  readonly inputId: string | undefined;

  constructor(input: {
    code: string;
    message: string;
    turnId: string;
    sessionId?: string;
    inputId?: string;
  }) {
    super(input.message);
    this.code = input.code;
    this.turnId = input.turnId;
    this.sessionId = input.sessionId;
    this.inputId = input.inputId;
  }
}

export class TurnInterruptedError extends TiDBLinkError {
  readonly turnId: string;

  constructor(
    turnId: string,
    message = "Turn was interrupted",
    readonly sessionId?: string,
    readonly inputId?: string,
  ) {
    super(message);
    this.turnId = turnId;
  }
}

/** Observation stopped locally; the original command can still be queried or observed. */
export class ObservationStoppedError extends OutcomeUnknownError {
  readonly cursor: string | undefined;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: {
      sessionId: string;
      inputId: string;
      turnId?: string;
      cursor?: string;
      requestId?: string;
      timedOut?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.cursor = options.cursor;
    this.timedOut = options.timedOut ?? false;
  }
}

/**
 * The event stream received no bytes, not even a keep-alive, within the idle
 * timeout. The connection is treated as dead; reconnect from `cursor`.
 */
export class StreamIdleError extends ConnectionError {
  readonly cursor: string | undefined;
  readonly idleTimeoutMs: number;

  constructor(options: {
    idleTimeoutMs: number;
    cursor?: string;
    requestId?: string;
  }) {
    super(
      `Session event stream was silent for ${options.idleTimeoutMs} ms; reconnect from the last cursor`,
      options.requestId === undefined ? undefined : { requestId: options.requestId },
    );
    this.cursor = options.cursor;
    this.idleTimeoutMs = options.idleTimeoutMs;
  }
}

/**
 * A Backend Connection closed, or could not be opened. `code` is the
 * WebSocket close code: 4001 means the Organization API Key is missing,
 * invalid, revoked or rotated, or its Organization is inactive, and
 * reconnecting cannot help (`retryable` is false). Other closes, such as a
 * drained or restarted replica, are retryable.
 */
export class BackendConnectionClosedError extends ConnectionError {
  readonly code: number;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(input: { code: number; reason?: string; message?: string; cause?: unknown }) {
    super(
      input.message ??
        `Backend Connection closed with code ${input.code}${input.reason ? `: ${input.reason}` : ""}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.code = input.code;
    this.reason = input.reason ?? "";
    this.retryable = input.code !== 4001 && input.code !== 4009;
  }
}

/**
 * The core answered a Backend Connection request with a JSON-RPC error.
 * `code` is the JSON-RPC error code; for -32000 (refused), `reason` names
 * why, for example `session_not_found` or `connection_full`.
 */
export class BackendRequestError extends TiDBLinkError {
  readonly code: number;
  readonly reason: string | undefined;

  constructor(input: { code: number; message: string; reason?: string }) {
    super(input.message);
    this.code = input.code;
    this.reason = input.reason;
  }
}
