/** Agent Service OpenAPI version supported by this SDK release. */
export const AGENT_SERVICE_API_VERSION = "0.0.1" as const;

export {
  AgentStackApiError,
  AgentStackError,
  ConflictError,
  ConnectionError,
} from "./errors.js";
export { ServiceUser, WorkspaceClient } from "./workspace.js";
export type { UserApiKey, WorkspaceClientOptions } from "./workspace.js";
