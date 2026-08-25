export class AgentStackError extends Error {
  readonly requestId: string | undefined;

  constructor(message: string, options?: { requestId?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.requestId = options?.requestId;
  }
}

export class AgentStackApiError extends AgentStackError {
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
    super(input.message, input.requestId === undefined ? undefined : { requestId: input.requestId });
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

export class ConflictError extends AgentStackApiError {}

export class ConnectionError extends AgentStackError {}

/** The request may have succeeded, so repeating it could create another effect. */
export class OutcomeUnknownError extends AgentStackError {
  readonly turnId: string | undefined;

  constructor(
    message: string,
    options?: { requestId?: string; turnId?: string; cause?: unknown },
  ) {
    super(message, options);
    this.turnId = options?.turnId;
  }
}

export class InvalidTurnEventError extends OutcomeUnknownError {}

export class TurnFailedError extends AgentStackError {
  readonly code: string;
  readonly turnId: string;

  constructor(input: { code: string; message: string; turnId: string }) {
    super(input.message);
    this.code = input.code;
    this.turnId = input.turnId;
  }
}

export class TurnInterruptedError extends AgentStackError {
  readonly turnId: string;

  constructor(turnId: string, message = "Turn was interrupted") {
    super(message);
    this.turnId = turnId;
  }
}
