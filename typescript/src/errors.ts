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

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
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
