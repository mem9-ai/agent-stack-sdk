import { OutcomeUnknownError, TiDBLinkApiError } from "./errors.js";
import {
  HttpClient,
  requireCreationKey,
  requireKnownKeys,
  requireTemplateId,
} from "./http.js";
import type { RequestOptions } from "./organization.js";

export interface SwitchTemplateInput extends RequestOptions {
  /** The active Template the Session moves to. */
  templateId: string;
  /** Keep the same key and input to recover a lost response. */
  idempotencyKey: string;
  /** Required as `true` when the target Template enables cross-Session Recall. */
  acknowledgeSessionRecall?: boolean;
}

const STATUSES = ["pending", "succeeded", "failed", "unchanged"] as const;

/**
 * `pending`: a Handoff Turn runs under the target Template; `succeeded`: the
 * Session is on the target; `failed`: it stays on its previous Template;
 * `unchanged`: the target matched the current configuration.
 */
export type TemplateSwitchStatus = (typeof STATUSES)[number];

interface TemplateSwitchReceiptBase {
  commandId: string;
  sessionId: string;
  /** The target Template. */
  agentTemplateId: string;
  /** The epoch the switch started from; after `succeeded`, the new current epoch. */
  configurationEpoch: number;
  createdAt: string;
  completedAt?: string;
}

export type TemplateSwitchReceipt =
  | (TemplateSwitchReceiptBase & {
      status: "pending";
      /** The running Handoff Turn, a `kind: "template_handoff"` Turn. */
      handoffTurnId: string;
      error?: never;
    })
  | (TemplateSwitchReceiptBase & {
      status: "succeeded";
      /** Absent when the Session had no history and no Handoff ran. */
      handoffTurnId?: string;
      error?: never;
    })
  | (TemplateSwitchReceiptBase & {
      status: "failed";
      handoffTurnId?: string;
      error: {
        code:
          | "session_switch_conflict"
          | "agent_template_unavailable"
          | "session_switch_unsupported";
      };
    })
  | (TemplateSwitchReceiptBase & {
      status: "unchanged";
      handoffTurnId?: never;
      error?: never;
    });

/** 503 codes the service returns before it records the switch. */
const REFUSED_BEFORE_RECORDING = new Set([
  "turn_admission_closed",
  "skill_package_store_unavailable",
]);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isReceipt = (
  value: unknown,
  sessionId: string,
  templateId: string,
): value is TemplateSwitchReceipt => {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  if (
    !isText(receipt.commandId) ||
    receipt.sessionId !== sessionId ||
    receipt.agentTemplateId !== templateId ||
    typeof receipt.createdAt !== "string" ||
    !Number.isInteger(receipt.configurationEpoch) ||
    (receipt.configurationEpoch as number) < 1 ||
    !(STATUSES as readonly unknown[]).includes(receipt.status)
  )
    return false;
  if (receipt.status === "pending") return isText(receipt.handoffTurnId);
  if (receipt.status === "failed") {
    const error = receipt.error as { code?: unknown } | null | undefined;
    return typeof error === "object" && error !== null && isText(error.code);
  }
  if (receipt.status === "unchanged")
    return receipt.handoffTurnId === undefined;
  return true;
};

const RECOVER =
  "repeat it with the same idempotencyKey and input to recover its receipt";

export async function switchTemplate(
  http: HttpClient,
  sessionId: string,
  input: SwitchTemplateInput,
): Promise<TemplateSwitchReceipt> {
  requireKnownKeys(
    input,
    [
      "templateId",
      "idempotencyKey",
      "acknowledgeSessionRecall",
      "signal",
      "requestId",
    ],
    "Template switch input",
  );
  requireTemplateId(input.templateId, "Template switch");
  requireCreationKey(input.idempotencyKey, "Template switch");
  const {
    templateId,
    idempotencyKey,
    acknowledgeSessionRecall,
    signal,
    requestId,
  } = input;
  if (
    acknowledgeSessionRecall !== undefined &&
    typeof acknowledgeSessionRecall !== "boolean"
  )
    throw new TypeError("acknowledgeSessionRecall must be a boolean");
  let result;
  try {
    result = await http.postResponse<{ receipt?: unknown }>(
      `/sessions/${encodeURIComponent(sessionId)}/template-switches`,
      {
        agentTemplateId: templateId,
        ...(acknowledgeSessionRecall === undefined
          ? {}
          : { acknowledgeSessionRecall }),
      },
      {
        idempotencyKey,
        idempotent: true,
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
  } catch (error) {
    if (!(error instanceof OutcomeUnknownError)) throw error;
    const cause = error.cause;
    if (
      cause instanceof TiDBLinkApiError &&
      cause.status === 503 &&
      REFUSED_BEFORE_RECORDING.has(cause.code)
    )
      throw cause;
    throw new OutcomeUnknownError(
      `Template switch outcome is unknown; ${RECOVER}`,
      {
        sessionId,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        cause: error,
      },
    );
  }
  const receipt = result.data?.receipt;
  if (!isReceipt(receipt, sessionId, templateId))
    throw new OutcomeUnknownError(
      `Template switch returned no usable receipt; ${RECOVER}`,
      { requestId: result.requestId, sessionId },
    );
  return receipt;
}
