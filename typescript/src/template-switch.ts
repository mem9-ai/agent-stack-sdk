import { OutcomeUnknownError } from "./errors.js";
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
  /** Keep the same key and input to recover a lost response or read the latest status. */
  idempotencyKey: string;
  /** Required as `true` when the target Template enables cross-Session Recall. */
  acknowledgeSessionRecall?: boolean;
}

/**
 * `pending`: a Handoff Turn runs under the target Template; `succeeded`: the
 * Session is on the target; `failed`: it stays on its previous Template;
 * `unchanged`: the target matched the current configuration.
 */
export type TemplateSwitchStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "unchanged";

export interface TemplateSwitchReceipt {
  commandId: string;
  sessionId: string;
  /** The target Template. */
  agentTemplateId: string;
  status: TemplateSwitchStatus;
  /** The epoch the switch started from; after `succeeded`, the new current epoch. */
  configurationEpoch: number;
  /** The Handoff Turn, a `kind: "template_handoff"` Turn; absent when none runs. */
  handoffTurnId?: string;
  createdAt: string;
  completedAt?: string;
  /** Set when `status` is `failed`. */
  error?: {
    code:
      | "session_switch_conflict"
      | "agent_template_unavailable"
      | "session_switch_unsupported";
  };
}

const STATUSES: readonly string[] = [
  "pending",
  "succeeded",
  "failed",
  "unchanged",
];

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
  requireCreationKey(input.idempotencyKey);
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
  const result = await http.postResponse<{ receipt?: unknown }>(
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
  const receipt = result.data?.receipt as
    | Partial<TemplateSwitchReceipt>
    | null
    | undefined;
  if (
    typeof receipt?.commandId !== "string" ||
    !receipt.commandId ||
    receipt.sessionId !== sessionId ||
    receipt.agentTemplateId !== templateId ||
    !STATUSES.includes(receipt.status as string) ||
    typeof receipt.configurationEpoch !== "number"
  )
    throw new OutcomeUnknownError(
      "Template switch returned no usable receipt; repeat it with the same idempotencyKey",
      { requestId: result.requestId, sessionId },
    );
  return receipt as TemplateSwitchReceipt;
}
