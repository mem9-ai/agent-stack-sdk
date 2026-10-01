/** Agent Service OpenAPI version supported by this SDK release. */
export const AGENT_SERVICE_API_VERSION = "0.0.1" as const;
/** Exact Agent Service revision whose public contract is supported by this SDK release. */
export const AGENT_SERVICE_REVISION =
  "7c12ed1a4f75ebb808b642f07f8fcd25259cf0f6" as const;

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
