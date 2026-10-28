/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Historical service baseline for retained APIs awaiting their refresh. */
export const TIDB_LINK_REVISION =
  "49f2bb3b7d194ada614cf9caa0a79f24e7aeba87" as const;

/** Exact service revision verified for Organization, End User and User Key provisioning. */
export const TIDB_LINK_PROVISIONING_REVISION =
  "b59a0a584eb2632b8d9c6d0808b8ea26081b1474" as const;

/** Exact service revision verified for Realtime Model and Connection preparation. */
export const TIDB_LINK_REALTIME_REVISION =
  "b59a0a584eb2632b8d9c6d0808b8ea26081b1474" as const;

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
export { OrganizationClient } from "./organization.js";
export type {
  Organization,
  EndUser,
  CreateEndUserInput,
  RequestOptions,
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
export type {
  OpenRealtimeConnectionInput,
  OpenRealtimeConnectionResult,
  RealtimeAudioFormat,
  RealtimeAudioFormats,
  RealtimeConnectGrant,
  RealtimeConnection,
  RealtimeEndpointingMode,
  RealtimeLanguage,
  RealtimeModel,
  RealtimeModelCatalog,
  RealtimeModelSelection,
  RealtimeOpusAudioFormat,
  RealtimePcm16AudioFormat,
  RealtimeVoiceSetting,
} from "./realtime.js";
export type { CreateTurnInput, TurnResult, TurnStreamEvent } from "./turn.js";
