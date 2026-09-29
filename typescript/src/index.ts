/** Agent Service OpenAPI version supported by this SDK release. */
export const AGENT_SERVICE_API_VERSION = "0.0.1" as const;
/** Exact Agent Service revision whose public contract is supported by this SDK release. */
export const AGENT_SERVICE_REVISION = "9c1e9aceb28afce1166e4249ea104c7a2f8aac73" as const;

export {
  AgentStackApiError,
  AgentStackError,
  ConflictError,
  ConnectionError,
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
} from "./errors.js";
export { OrganizationClient, ServiceUser } from "./organization.js";
export type {
  IssuedUserApiKey,
  OrganizationClientOptions,
  UserApiKey,
} from "./organization.js";
export { Agent, UserClient } from "./user.js";
export type {
  AgentConfigInput,
  AgentConfigPatch,
  AgentRecord,
  AgentTemplate,
  AgentTemplateProvenance,
  CreateAgentInput,
  EnabledAgentCapability,
  McpServerReference,
  MemoryCredentialInput,
  PublicAgentConfig,
  UserClientOptions,
} from "./user.js";
export { Session } from "./session.js";
export type {
  BillingTag,
  ClarificationItem,
  MessageRecord,
  SelectableSessionModel,
  SessionModel,
  SessionRecord,
  TurnRecord,
} from "./session.js";
export type { CreateTurnInput, TurnResult, TurnStreamEvent } from "./turn.js";
