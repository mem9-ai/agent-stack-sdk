import { OutcomeUnknownError } from "./errors.js";
import { HttpClient, requireCreationKey, requireKnownKeys } from "./http.js";
import { requireInteraction, type SessionInteraction } from "./history.js";
import type { RequestOptions } from "./organization.js";

export interface TurnCommandInput extends RequestOptions {
  /** Persist this new Session-local command identity before dispatch. */
  clientEventId: string;
  turnId: string;
}

export interface RetryReceipt {
  clientEventId: string;
  sessionId: string;
  turnId: string;
  disposition: "retrying";
}

export function submitTurnCommand(
  http: HttpClient,
  sessionId: string,
  kind: "cancel",
  input: TurnCommandInput,
): Promise<SessionInteraction>;
export function submitTurnCommand(
  http: HttpClient,
  sessionId: string,
  kind: "retry",
  input: TurnCommandInput,
): Promise<RetryReceipt>;
export async function submitTurnCommand(
  http: HttpClient,
  sessionId: string,
  kind: "cancel" | "retry",
  input: TurnCommandInput,
): Promise<SessionInteraction | RetryReceipt> {
  requireKnownKeys(
    input,
    ["clientEventId", "turnId", "signal", "requestId"],
    "Turn command",
  );
  requireCreationKey(input.clientEventId);
  if (
    typeof input.turnId !== "string" ||
    !input.turnId ||
    input.turnId.length > 64
  )
    throw new TypeError(
      "Turn command requires a turnId containing 1-64 characters",
    );
  const { clientEventId, turnId, signal, requestId } = input;
  signal?.throwIfAborted();
  try {
    const result = await http.postResponse<{
      interaction?: unknown;
      event?: RetryReceipt;
    }>(
      `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/events`,
      { type: `agent.session.input.${kind}`, clientEventId, data: { turnId } },
      {
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
    try {
      if (kind === "cancel") {
        const receipt = requireInteraction(
          result.data?.interaction,
          clientEventId,
          result.requestId,
        );
        if (
          receipt.kind !== kind ||
          receipt.turnId !== turnId ||
          receipt.message !== null
        )
          throw new Error(
            "Cancellation receipt identifies a different command",
          );
        return receipt;
      }
      const receipt = result.data?.event;
      if (
        receipt?.clientEventId !== clientEventId ||
        receipt.sessionId !== sessionId ||
        receipt.turnId !== turnId ||
        receipt.disposition !== "retrying"
      )
        throw new Error("Retry receipt identifies a different command");
      return receipt;
    } catch (cause) {
      throw new OutcomeUnknownError(
        "Turn command returned no usable receipt; query its original identity",
        { requestId: result.requestId, cause },
      );
    }
  } catch (cause) {
    if (!(cause instanceof OutcomeUnknownError)) throw cause;
    throw new OutcomeUnknownError(cause.message, {
      sessionId,
      inputId: clientEventId,
      turnId,
      ...(cause.requestId ? { requestId: cause.requestId } : {}),
      cause,
    });
  }
}
