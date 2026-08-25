/** Agent Service OpenAPI version supported by this SDK release. */
export const AGENT_SERVICE_API_VERSION = "0.0.1" as const;

export {
  AgentStackApiError,
  AgentStackError,
  ConflictError,
  ConnectionError,
  OutcomeUnknownError,
} from "./errors.js";
export { ServiceUser, WorkspaceClient } from "./workspace.js";
export type {
  IssuedUserApiKey,
  ServiceUserRecord,
  UserApiKey,
  WorkspaceClientOptions,
  WorkspaceMembership,
} from "./workspace.js";
export { Agent, UserClient } from "./user.js";
export type {
  AgentRecord,
  AgentTemplate,
  AgentTemplateProvenance,
  CreateAgentInput,
  UserClientOptions,
} from "./user.js";
export { Session } from "./session.js";
export type {
  ClarificationItem,
  MessageRecord,
  SessionRecord,
  TurnRecord,
} from "./session.js";
