import {
  OutcomeUnknownError,
  TiDBLinkApiError,
  TiDBLinkError,
  TurnFailedError,
  TurnInterruptedError,
  TurnWaitTimeoutError,
  InputNotAppliedError,
} from "./errors.js";
import {
  HttpClient,
  sleep,
  requireCreationKey,
  requireKnownKeys,
} from "./http.js";
import {
  getInteraction,
  getTurn,
  requireInteraction,
  type SessionInteraction,
} from "./history.js";
import type { BillingTag, ClarificationItem } from "./session.js";

export interface CreateTurnInput {
  /** Persist this Session-local command identity before dispatch. */
  clientEventId: string;
  text: string | [string, ...string[]];
  userFileIds?: string[];
  clarificationSourceTurnId?: string;
  billingTag?: BillingTag | null;
  requestId?: string;
  signal?: AbortSignal;
}

export interface WaitForResultOptions {
  /** Local deadline only; default 60 seconds. Never cancels execution. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestId?: string;
  signal?: AbortSignal;
}

type ResultIdentity = {
  sessionId: string;
  inputId: string;
  turnId: string;
  messageId: string;
  text: string;
  interaction: SessionInteraction;
};
export type TurnResult = ResultIdentity &
  (
    | { type: "answer" }
    | { type: "clarification"; clarification: ClarificationItem }
  );

export const submitMessage = async (
  http: HttpClient,
  sessionId: string,
  input: CreateTurnInput,
): Promise<SessionInteraction> => {
  requireKnownKeys(
    input,
    [
      "clientEventId",
      "text",
      "userFileIds",
      "clarificationSourceTurnId",
      "billingTag",
      "requestId",
      "signal",
    ],
    "Message input",
  );
  requireCreationKey(input.clientEventId);
  const { clientEventId, requestId, signal, ...data } = input;
  const texts = typeof data.text === "string" ? [data.text] : data.text;
  if (
    !Array.isArray(texts) ||
    texts.length < 1 ||
    texts.length > 9 ||
    texts.some((t) => typeof t !== "string" || !t)
  )
    throw new TypeError("text must contain 1-9 non-empty values");
  if (
    data.userFileIds !== undefined &&
    (!Array.isArray(data.userFileIds) ||
      data.userFileIds.length > 20 ||
      data.userFileIds.some(
        (id) => typeof id !== "string" || !id || id.length > 64,
      ))
  )
    throw new TypeError("userFileIds must contain at most 20 non-empty IDs");
  if (
    data.clarificationSourceTurnId !== undefined &&
    (typeof data.clarificationSourceTurnId !== "string" ||
      !data.clarificationSourceTurnId ||
      data.clarificationSourceTurnId.length > 64)
  )
    throw new TypeError(
      "clarificationSourceTurnId must contain 1-64 characters",
    );
  signal?.throwIfAborted();
  try {
    const result = await http.postResponse<{ interaction?: unknown }>(
      `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/events`,
      { type: "agent.session.input.message", clientEventId, data },
      {
        ...(requestId ? { requestId } : {}),
        ...(signal ? { signal } : {}),
        outcomeUnknown: true,
      },
    );
    try {
      const receipt = requireInteraction(
        result.data?.interaction,
        clientEventId,
        result.requestId,
      );
      if (
        receipt.kind !== "message" ||
        !receipt.message ||
        receipt.message.role !== "user"
      )
        throw new TiDBLinkError(
          "Message submission returned a different command receipt",
        );
      return receipt;
    } catch (cause) {
      throw new OutcomeUnknownError(
        "Message submission returned no usable receipt; query the original input",
        { requestId: result.requestId, cause },
      );
    }
  } catch (cause) {
    if (!(cause instanceof OutcomeUnknownError)) throw cause;
    throw new OutcomeUnknownError(cause.message, {
      sessionId,
      inputId: clientEventId,
      ...(cause.requestId ? { requestId: cause.requestId } : {}),
      cause,
    });
  }
};

export const validateWaitOptions = (
  options: WaitForResultOptions = {},
): { timeoutMs: number; pollIntervalMs: number } => {
  requireKnownKeys(
    options,
    ["timeoutMs", "pollIntervalMs", "requestId", "signal"],
    "Wait options",
  );
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new TypeError(
      "timeoutMs must be an integer between 0 and 2147483647",
    );
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 2_147_483_647
  )
    throw new TypeError(
      "pollIntervalMs must be an integer between 1 and 2147483647",
    );
  return { timeoutMs, pollIntervalMs };
};

export const waitForResult = async (
  http: HttpClient,
  sessionId: string,
  inputId: string,
  options: WaitForResultOptions = {},
): Promise<TurnResult> => {
  const { timeoutMs, pollIntervalMs } = validateWaitOptions(options);
  requireCreationKey(inputId);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let turnId: string | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      const interaction = await getInteraction(http, sessionId, inputId, {
        signal,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      });
      turnId = interaction.turnId;
      if (
        interaction.kind !== "message" ||
        !interaction.message ||
        interaction.message.role !== "user"
      )
        throw new TiDBLinkError(
          "Waiting for a text result requires a message receipt",
        );
      if (interaction.rejection || interaction.mode === "rejected")
        throw new InputNotAppliedError(sessionId, inputId, turnId);
      if (
        interaction.result.status !== "running" &&
        !interaction.result.completedAt
      )
        throw new TiDBLinkError(
          "Original terminal receipt omitted its completion time",
        );
      if (interaction.result.status === "failed")
        throw new TurnFailedError({
          code: "turn_failed",
          message: "The original Turn execution failed",
          turnId,
          sessionId,
          inputId,
        });
      if (interaction.result.status === "interrupted")
        throw new TurnInterruptedError(turnId, undefined, sessionId, inputId);
      if (interaction.result.status === "succeeded") {
        if (!interaction.appliedAt)
          throw new InputNotAppliedError(sessionId, inputId, turnId);
        const turn = await getTurn(http, sessionId, turnId, {
          signal,
          ...(options.requestId ? { requestId: options.requestId } : {}),
        });
        const message = turn.assistantMessage;
        if (
          turn.executor === "realtime_model" ||
          turn.status !== "succeeded" ||
          !interaction.result.completedAt ||
          turn.completedAt !== interaction.result.completedAt ||
          !message ||
          message.role !== "assistant" ||
          !message.id ||
          typeof message.content !== "string" ||
          message.turnId !== turnId ||
          message.sessionId !== sessionId
        )
          throw new TiDBLinkError(
            "Saved Turn does not match the original successful execution",
          );
        const identity = {
          sessionId,
          inputId,
          turnId,
          messageId: message.id,
          text: message.content,
          interaction,
        };
        return turn.clarificationItem
          ? {
              ...identity,
              type: "clarification",
              clarification: turn.clarificationItem,
            }
          : { ...identity, type: "answer" };
      }
      await sleep(pollIntervalMs, signal);
    }
  } catch (cause) {
    if (
      cause instanceof TurnFailedError ||
      cause instanceof TurnInterruptedError ||
      cause instanceof InputNotAppliedError ||
      cause instanceof TiDBLinkApiError
    )
      throw cause;
    const ErrorClass =
      deadline.signal.aborted && !options.signal?.aborted
        ? TurnWaitTimeoutError
        : OutcomeUnknownError;
    throw new ErrorClass(
      ErrorClass === TurnWaitTimeoutError
        ? "Local wait timed out; query or wait for the original input"
        : "Local wait stopped before the original result was established",
      {
        sessionId,
        inputId,
        ...(turnId ? { turnId } : {}),
        ...(cause instanceof TiDBLinkError && cause.requestId
          ? { requestId: cause.requestId }
          : options.requestId
            ? { requestId: options.requestId }
            : {}),
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
  }
};
