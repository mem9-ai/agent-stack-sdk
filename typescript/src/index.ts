/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact service baseline for the supported refreshed SDK surface. */
export const TIDB_LINK_REVISION =
  "89fca0b3ecd4207aa96fea64cfe9ae583b8f21d6" as const;

export {
  TiDBLinkApiError,
  TiDBLinkError,
  ConflictError,
  ConnectionError,
  TurnWaitTimeoutError,
  InputNotAppliedError,
  OutcomeUnknownError,
  ObservationStoppedError,
  StreamIdleError,
  TurnFailedError,
  TurnInterruptedError,
  BackendConnectionClosedError,
  BackendRequestError,
} from "./errors.js";
export { OrganizationClient } from "./organization.js";
export { SessionConnection } from "./session-connection.js";
export type {
  ConnectOptions,
  ClientToolHandler,
  ClientToolHandlers,
  ClientToolCallContext,
  RealtimeTranscript,
  RealtimeResponse,
  SessionConnectionEnd,
} from "./session-connection.js";
export type {
  BackendWebSocket,
  WebSocketConstructor,
} from "./backend-connection.js";
export type {
  Organization,
  EndUser,
  CreateEndUserInput,
  RequestOptions,
  OrganizationClientOptions,
} from "./organization.js";
export { Templates } from "./templates.js";
export type {
  Template,
  TemplateSummary,
  TemplateContent,
  TemplateRealtimeLanguage,
  TemplatePage,
  TemplateListOptions,
  TemplateCatalog,
  TemplateInput,
  CreateTemplateInput,
  TemplateMutationOptions,
} from "./templates.js";
export { Skills } from "./skills.js";
export type {
  SkillSummary,
  SkillVersion,
  SkillPage,
  SkillDetail,
  SkillUpload,
  SkillUploadState,
  UploadSkillInput,
  PublishSkillOptions,
  WaitForSkillUploadOptions,
} from "./skills.js";
export { Connectors } from "./connectors.js";
export type {
  Connector,
  ConnectorTransport,
  RegisterConnectorInput,
  UpdateConnectorInput,
  ConnectorVersionOptions,
} from "./connectors.js";
export {
  ConnectorKeySet,
  ConnectorAuthError,
  verifyConnectorCallback,
  readConnectorCallContext,
  CONNECTOR_CALLBACK_ISSUER,
  CONNECTOR_CALLBACK_AUDIENCE,
  CONNECTOR_CALL_CONTEXT_KEY,
} from "./connector-callback.js";
export type {
  ConnectorVerificationKey,
  ConnectorCallbackClaims,
  ConnectorCallContext,
  ConnectorKeySetOptions,
  VerifyConnectorCallbackOptions,
} from "./connector-callback.js";
export { EndUserClient } from "./user.js";
export type {
  AgentTemplate,
  AgentTemplatePage,
  AgentModelCatalog,
  SessionListOptions,
  SessionPage,
} from "./user.js";
export type { ListOptions, FetchFunction } from "./http.js";
export { Session } from "./session.js";
export type {
  BillingTag,
  CreateSessionOptions,
  SessionSandboxSelection,
  SuggestSessionNameInput,
  ClarificationItem,
  SelectableSessionModel,
  SessionModel,
  SessionRecord,
} from "./session.js";
export type {
  SwitchTemplateInput,
  TemplateSwitchReceipt,
  TemplateSwitchStatus,
} from "./template-switch.js";
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
export type {
  CreateTurnInput,
  TurnResult,
  WaitForResultOptions,
} from "./turn.js";
export type {
  MessageRecord,
  MessageInputContext,
  RealtimeMessageMetadata,
  TurnRecord,
  FullAgentTurnRecord,
  RealtimeTurnRecord,
  TemplateHandoffTurnRecord,
  TurnPage,
  TurnStatus,
  TurnUserFile,
  TurnFailure,
  OperationRecord,
  OperationStatus,
  OperationResultPointer,
  SessionInteraction,
  SessionInteractionPage,
  SessionRealtimeEvent,
  RealtimeResponseKind,
  SessionTimelineEntry,
  SessionTemplateSwitch,
  SessionTimelinePage,
} from "./history.js";

export type { TurnCommandInput, RetryReceipt } from "./control.js";
export { UserFiles, FileUploadOutcomeUnknownError } from "./files.js";
export type {
  UserFile,
  FileUploadCapabilities,
  CreateFileUploadInput,
  UploadFileInput,
  FileUpload,
  FileUploadStatus,
  FileUploadPart,
  UploadedFilePart,
  FileListOptions,
  FilePage,
  FileDownloadGrant,
  FileContent,
} from "./files.js";
export type {
  SessionEventsOptions,
  ObserveTurnOptions,
  TurnObservation,
} from "./progress.js";
export { parseSessionEvent, asKnownSessionEvent } from "./events.js";
export type {
  SessionEvent,
  KnownSessionEvent,
  TurnEventData,
  TurnStartedEvent,
  TurnDraftEvent,
  TurnProgressEvent,
  TurnItemAddedEvent,
  OperationStepPayload,
  TurnRequiresActionEvent,
  ClientToolCallPayload,
  TurnCompletedEvent,
  TurnCancelledEvent,
  TurnFailedEvent,
  RealtimeTranscriptEvent,
  RealtimeResponseEvent,
  TemplateSwitchEvent,
  TemplateSwitchEventData,
} from "./events.js";
export type { SubscribeOptions, SubscriptionItem } from "./subscription.js";

export type {
  BillingUsageFactKind,
  BillingCostBearer,
  BillingPrincipalBucket,
  BillingAttributionKind,
  BillingLlmRequestPurpose,
  LlmPricingStatus,
  LlmPricingContextTier,
  SandboxUsageStatus,
  BillingUsageEvidenceStatus,
  BillingValuationStatus,
  BillingValuationSummary,
  BillingValuationBreakdown,
  BillingFactCompletenessCounters,
  BillingFactCompleteness,
  UsageTotals,
  BillingBearerCostTotals,
  BillingAttributionCounters,
  BillingAttributionBreakdown,
  LlmUsageAggregate,
  SandboxUsageAggregate,
  WebSearchUsageAggregate,
  BillingUsageSeriesInterval,
  BillingUsageSeriesRange,
  BillingUsageSeriesLlmBreakdown,
  BillingUsageSeriesSandboxBreakdown,
  BillingUsageSeriesWebSearchBreakdown,
  BillingUsageSeriesBreakdown,
  BillingUsageSeriesBreakdownGroups,
  BillingUsageSeriesPoint,
  OrganizationUserUsageSummary,
  OrganizationLlmUsage,
  OrganizationSandboxUsage,
  OrganizationWebSearchUsage,
  OrganizationUsageItem,
  OrganizationUserUsageDetails,
  OrganizationUserUsageOptions,
  OrganizationUserUsageDetailsOptions,
} from "./usage.js";
export type {
  ClientToolDeclaration,
  ClientToolSet,
  ReplaceClientToolsOptions,
  PendingClientToolCall,
  ClientToolOutputInput,
} from "./client-tools.js";
export { AudioTurnStoppedError } from "./audio.js";
export type {
  AudioTurnInput,
  AudioTurnEvent,
  AudioTurnResult,
} from "./audio.js";
