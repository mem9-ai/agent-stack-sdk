/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact service baseline for the supported refreshed SDK surface. */
export const TIDB_LINK_REVISION =
  "882287809f91d9a3fdf60537460431d9f0fc23e7" as const;

export {
  TiDBLinkApiError,
  TiDBLinkError,
  ConflictError,
  ConnectionError,
  TurnWaitTimeoutError,
  InputNotAppliedError,
  OutcomeUnknownError,
  ObservationStoppedError,
  TurnFailedError,
  TurnInterruptedError,
} from "./errors.js";
export { OrganizationClient } from "./organization.js";
export type {
  Organization,
  EndUser,
  CreateEndUserInput,
  RequestOptions,
  OrganizationClientOptions,
} from "./organization.js";
export { Agent, EndUserClient } from "./user.js";
export type {
  AgentRecord,
  AgentTemplate,
  AgentTemplatePage,
  AgentModelCatalog,
  CreateAgentInput,
  UpdateAgentInput,
  SessionPage,
} from "./user.js";
export type { ListOptions } from "./http.js";
export { Session } from "./session.js";
export type {
  BillingTag,
  CreateSessionOptions,
  SuggestSessionNameInput,
  ClarificationItem,
  SelectableSessionModel,
  SessionModel,
  SessionRecord,
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
  SessionEvent,
  SessionEventsOptions,
  ObserveTurnOptions,
  TurnObservation,
} from "./progress.js";

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
