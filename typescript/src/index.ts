/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact TiDB Link revision whose public contract is supported by this SDK release. */
export const TIDB_LINK_REVISION =
  "e1d534d925d46e1658f8d93a2da35c7ed94a754a" as const;

export {
  TiDBLinkApiError,
  TiDBLinkError,
  ConflictError,
  ConnectionError,
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
} from "./errors.js";
export { OrganizationClient, BusinessUser } from "./organization.js";
export type {
  OrganizationRecord,
  BusinessUserRecord,
  CreateBusinessUserInput,
  IssuedUserApiKey,
  OrganizationClientOptions,
  UserApiKey,
} from "./organization.js";
export { Agent, UserClient } from "./user.js";
export type { AgentRecord, AgentTemplate, AgentTemplatePage, CreateAgentInput, UserClientOptions } from "./user.js";
export { Session } from "./session.js";
export type {
  BillingTag,
  CreateSessionOptions,
  ClarificationItem,
  MessageRecord,
  Interaction,
  InteractionPage,
  SessionModel,
  SessionRecord,
  SessionTemplateProvenance,
  TurnRecord,
} from "./session.js";
export type { CreateTurnInput, StopTurnInput, InteractionReceipt, TurnResult, TurnStreamEvent, TurnStreamItem } from "./turn.js";
