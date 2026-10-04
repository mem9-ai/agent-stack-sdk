/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact TiDB Link revision whose public contract is supported by this SDK release. */
export const TIDB_LINK_REVISION =
  "8703fc32ac89fcb59f1e583f9f95ecaaa84dd501" as const;

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
