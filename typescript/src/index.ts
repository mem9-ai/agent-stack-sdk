/** TiDB Link OpenAPI version supported by this SDK release. */
export const TIDB_LINK_API_VERSION = "0.0.1" as const;
/** Exact service baseline for the supported refreshed SDK surface. */
export const TIDB_LINK_REVISION =
  "0d11f1b231879c735bd53b60ff895ac58ba60d33" as const;

/** Exact service revision verified for Organization, End User and User Key provisioning. */
export const TIDB_LINK_PROVISIONING_REVISION =
  "0d11f1b231879c735bd53b60ff895ac58ba60d33" as const;

/** Exact service revision verified for Realtime Model and Connection preparation. */
export const TIDB_LINK_REALTIME_REVISION =
  "0d11f1b231879c735bd53b60ff895ac58ba60d33" as const;

/** Exact service revision verified for Template, Agent and Session lifecycle. */
export const TIDB_LINK_LIFECYCLE_REVISION =
  "0d11f1b231879c735bd53b60ff895ac58ba60d33" as const;

/** Exact service revision verified for text commands, original results and history. */
export const TIDB_LINK_TEXT_REVISION =
  "0d11f1b231879c735bd53b60ff895ac58ba60d33" as const;

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
  IssuedUserApiKey,
  OrganizationClientOptions,
  UserApiKey,
} from "./organization.js";
export { Agent, UserClient } from "./user.js";
export type {
  AgentRecord,
  AgentTemplate,
  AgentTemplatePage,
  AgentModelCatalog,
  CreateAgentInput,
  UpdateAgentInput,
  SessionPage,
  UserClientOptions,
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
  BillingAuthKind,
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
  UserUsageScopeLevel,
  UserUsagePeriod,
  UserUsageScope,
  UserUsageRange,
  UsageTotals,
  BillingBearerCostTotals,
  BillingAttributionCounters,
  BillingAttributionBreakdown,
  LlmUsageAggregate,
  UserUsageAggregate,
  SandboxUsageAggregate,
  WebSearchUsageAggregate,
  UsageDayPoint,
  BillingUsageSeriesInterval,
  BillingUsageSeriesRange,
  BillingUsageSeriesLlmBreakdown,
  BillingUsageSeriesSandboxBreakdown,
  BillingUsageSeriesWebSearchBreakdown,
  BillingUsageSeriesBreakdown,
  BillingUsageSeriesBreakdownGroups,
  BillingUsageSeriesPoint,
  UserUsageSummary,
  UserLlmUsage,
  UserSandboxUsage,
  UserWebSearchUsage,
  UserUsageDetails,
  OrganizationUserUsageSummary,
  OrganizationLlmUsage,
  OrganizationSandboxUsage,
  OrganizationWebSearchUsage,
  OrganizationUsageItem,
  OrganizationUserUsageDetails,
  UserUsageOptions,
  UserUsageDetailsOptions,
  OrganizationUserUsageOptions,
  OrganizationUserUsageDetailsOptions,
} from "./usage.js";
export { UserSchedulers } from "./schedulers.js";
export type {
  SchedulerSchedule,
  SchedulerDelivery,
  CreateSchedulerInput,
  UpdateSchedulerInput,
  Scheduler,
  SchedulerResponse,
  SchedulerPage,
  SchedulerListOptions,
  SchedulerMutationOptions,
  SchedulerFire,
  SchedulerFirePage,
} from "./schedulers.js";
