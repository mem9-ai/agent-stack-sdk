/** OpenAPI version; compatibility also requires the exact provisioning baseline below. */
export const AGENT_SERVICE_API_VERSION = "0.0.1" as const;

/** Exact service revision verified for Organization/End User/Key provisioning only. */
export const AGENT_SERVICE_REVISION =
  "b59a0a584eb2632b8d9c6d0808b8ea26081b1474" as const;

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
export { OrganizationClient } from "./organization.js";
export type {
  OrganizationClientOptions,
  Organization,
  EndUser,
  CreateEndUserInput,
  RequestOptions,
} from "./organization.js";
export type { IssuedUserApiKey, UserApiKey } from "./organization.js";
export { Agent, listProjects, UserClient } from "./user.js";
export type {
  AgentConfigInput,
  AgentConfigPatch,
  AgentRecord,
  AgentRuntimeConfigInput,
  AgentTemplate,
  AgentTemplateProvenance,
  CreateAgentInput,
  EnabledAgentCapability,
  ManagedToolReference,
  PublicAgentConfig,
  PublicAgentLarkConfig,
  PublicAgentRuntimeConfig,
  ProjectDiscoveryOptions,
  ProjectRecord,
  UserClientOptions,
} from "./user.js";
export { Session } from "./session.js";
export type {
  ClarificationItem,
  MessageRecord,
  SessionRecord,
  TurnRecord,
} from "./session.js";
export type { CreateTurnInput, TurnResult, TurnStreamEvent } from "./turn.js";
