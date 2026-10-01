/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact TiDB Link revision whose public contract is supported by this SDK release. */
export const TIDB_LINK_REVISION =
  "49f2bb3b7d194ada614cf9caa0a79f24e7aeba87" as const;

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
export { OrganizationClient, ServiceUser } from "./organization.js";
export type {
  IssuedUserApiKey,
  OrganizationClientOptions,
  UserApiKey,
} from "./organization.js";
export { Agent, UserClient } from "./user.js";
export type {
  HardwareRequirement,
  PublishedTemplateVersion,
  ApplyTemplateInput,
  TemplateApplicationPreview,
  TemplateOverridePath,
  TemplateContent,
  TemplateOverrides,
  TemplateApplicationReference,
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
