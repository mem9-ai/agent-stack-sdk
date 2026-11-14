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
 * why, for example `session_not_found` or `connection_full`. A refused
 * `session.send` carries the REST message command's error code as `reason`,
 * such as `session_read_only` or `turn_admission_closed`.
 */
export class BackendRequestError extends TiDBLinkError {
  readonly code: number;
  readonly reason: string | undefined;
  /** For a refused `session.send`, the REST error's `details`. */
  readonly details: unknown;

  constructor(input: {
    code: number;
    message: string;
    reason?: string;
    details?: unknown;
  }) {
    super(input.message);
    this.code = input.code;
    this.reason = input.reason;
    this.details = input.details;
  }
}
