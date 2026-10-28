import { requireKnownKeys } from "./http.js";
import type { RequestOptions } from "./organization.js";
import type { BillingTag } from "./session.js";

export type BillingUsageFactKind = "llm" | "sandbox" | "web_search";
export type BillingCostBearer = "platform" | "customer" | "unknown";
export type BillingPrincipalBucket =
  | "human"
  | "user_api_key"
  | "organization_machine";
export type BillingAttributionKind =
  | "agent"
  | "user_level"
  | "system"
  | "unattributed";
export type BillingAuthKind =
  | "session"
  | "user-api-key"
  | "organization-api-key"
  | "system";
export type BillingLlmRequestPurpose =
  | "agent_turn"
  | "compaction"
  | "auto_title"
  | "manual_title"
  | "asr"
  | "voice_realtime";
export type LlmPricingStatus = "estimated" | "unknown";
export type LlmPricingContextTier =
  | "short"
  | "long"
  | "all_context"
  | "unknown";
export type SandboxUsageStatus =
  | "running"
  | "closed"
  | "close_failed"
  | "abandoned";
export type BillingUsageEvidenceStatus =
  | "complete"
  | "partial"
  | "missing"
  | "unsupported";
export type BillingValuationStatus = "priced" | "unpriced";
export interface BillingValuationSummary {
  status: "complete" | "incomplete";
  pricedUsageCount: number;
  unpricedUsageCount: number;
  pricedCostMicros: number;
}
export interface BillingValuationBreakdown extends BillingValuationSummary {
  byKind: Partial<Record<BillingUsageFactKind, BillingValuationSummary>>;
}
export interface BillingFactCompletenessCounters {
  status: "complete" | "incomplete";
  projectedFactCount: number;
  pendingIntentCount: number;
  indeterminateIntentCount: number;
  failedIntentCount: number;
}
export interface BillingFactCompleteness extends BillingFactCompletenessCounters {
  byKind: Partial<
    Record<BillingUsageFactKind, BillingFactCompletenessCounters>
  >;
}

export type UserUsageScopeLevel = "user";
export type UserUsagePeriod = "day" | "week";

export interface UserUsageScope {
  level: UserUsageScopeLevel;
  organizationId: string;
  userId: string;
}

export interface UserUsageRange {
  period: UserUsagePeriod;
  from: string;
  to: string;
}

export interface UsageTotals {
  currency: "USD";
  /** Platform-borne priced cost; other bearers remain in costByBearer. */
  totalCostMicros: number;
  llmCostMicros: number;
  sandboxCostMicros: number;
  webSearchCostMicros: number;
  costByBearer: Record<BillingCostBearer, BillingBearerCostTotals>;
  organizationMachineCostMicros: number;
  llmRequestCount: number;
  unknownLlmRequestCount: number;
  sandboxUsageCount: number;
  webSearchRequestCount: number;
  unsettledCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unpricedLlmTokens: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  sandboxDurationSeconds: number;
  valuation: BillingValuationBreakdown;
  attribution: BillingAttributionBreakdown;
}

export interface BillingBearerCostTotals {
  totalCostMicros: number;
  llmCostMicros: number;
  sandboxCostMicros: number;
  webSearchCostMicros: number;
}

export interface BillingAttributionCounters {
  status: "complete" | "incomplete";
  classifiedUsageCount: number;
  agentUsageCount: number;
  userLevelUsageCount: number;
  systemUsageCount: number;
  unattributedUsageCount: number;
}

export interface BillingAttributionBreakdown extends BillingAttributionCounters {
  byKind: Partial<Record<BillingUsageFactKind, BillingAttributionCounters>>;
}

export interface LlmUsageAggregate {
  costBearer: BillingCostBearer;
  provider: string;
  model: string;
  requestPurpose: BillingLlmRequestPurpose;
  principalBucket: BillingPrincipalBucket;
  requestCount: number;
  unknownRequestCount: number;
  costMicros: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  valuation: BillingValuationSummary;
}

export interface UserUsageAggregate {
  costBearer: BillingCostBearer;
  userId: string;
  displayName: string | null;
  currency: "USD";
  totalCostMicros: number;
  llmCostMicros: number;
  sandboxCostMicros: number;
  webSearchCostMicros: number;
  llmRequestCount: number;
  unknownLlmRequestCount: number;
  sandboxUsageCount: number;
  webSearchRequestCount: number;
  unsettledCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  sandboxDurationSeconds: number;
  valuation: BillingValuationSummary;
}

export interface SandboxUsageAggregate {
  costBearer: BillingCostBearer;
  provider: "e2b" | "tencent_ags" | "run9";
  profileId: string;
  specKey: string;
  principalBucket: BillingPrincipalBucket;
  usageCount: number;
  settledUsageCount: number;
  unsettledCount: number;
  costMicros: number;
  durationSeconds: number;
  valuation: BillingValuationSummary;
}

export interface WebSearchUsageAggregate {
  costBearer: BillingCostBearer;
  provider: "exa";
  searchType: "auto";
  principalBucket: BillingPrincipalBucket;
  requestCount: number;
  requestedResultCount: number;
  returnedResultCount: number;
  costMicros: number;
  valuation: BillingValuationSummary;
}

export interface UsageDayPoint {
  date: string;
  costMicros: number;
  llmCostMicros: number;
  sandboxCostMicros: number;
  webSearchCostMicros: number;
  unknownLlmRequestCount: number;
  unsettledCount: number;
  valuation: BillingValuationSummary;
}

export type BillingUsageSeriesInterval = "hour" | "day" | "week" | "month";

export interface BillingUsageSeriesRange {
  from: string;
  to: string;
  interval: BillingUsageSeriesInterval;
}

interface BillingUsageSeriesBreakdownCommon {
  provider: string;
  costMicros: number;
  truncatedCombinations?: number;
}

export interface BillingUsageSeriesLlmBreakdown extends BillingUsageSeriesBreakdownCommon {
  kind: "llm";
  model?: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
}

export interface BillingUsageSeriesSandboxBreakdown extends BillingUsageSeriesBreakdownCommon {
  kind: "sandbox";
  usage: {
    durationSeconds: number;
    usageCount: number;
  };
}

export interface BillingUsageSeriesWebSearchBreakdown extends BillingUsageSeriesBreakdownCommon {
  kind: "web_search";
  usage: {
    requestCount: number;
  };
}

export type BillingUsageSeriesBreakdown =
  | BillingUsageSeriesLlmBreakdown
  | BillingUsageSeriesSandboxBreakdown
  | BillingUsageSeriesWebSearchBreakdown;

export type BillingUsageSeriesBreakdownGroups = Record<
  BillingCostBearer,
  BillingUsageSeriesBreakdown[]
>;

export interface BillingUsageSeriesPoint {
  bucketStart: string;
  costMicros: number;
  llmCostMicros: number;
  sandboxCostMicros: number;
  webSearchCostMicros: number;
  unknownLlmRequestCount: number;
  unsettledCount: number;
  breakdown: BillingUsageSeriesBreakdownGroups;
  valuation: BillingValuationSummary;
}

export interface UserUsageSummary {
  scope: UserUsageScope;
  range: UserUsageRange;
  factCompleteness: BillingFactCompleteness;
  totals: UsageTotals;
  users: { aggregates: UserUsageAggregate[] };
  llm: { aggregates: LlmUsageAggregate[] };
  sandbox: { aggregates: SandboxUsageAggregate[] };
  webSearch: { aggregates: WebSearchUsageAggregate[] };
  series: UsageDayPoint[];
}

export interface UserLlmUsage {
  kind: "llm";
  id: string;
  occurredAt: string;
  organizationId: string;
  sessionId: string;
  /** Null only for Realtime connection-scoped usage (`requestPurpose: voice_realtime`). */
  turnId: string | null;
  /** The Realtime connection of `voice_realtime` usage; null otherwise. */
  realtimeConnectionId: string | null;
  agentRunId: string | null;
  agentId: string | null;
  attributionKind: BillingAttributionKind;
  ownerUserId: string | null;
  authKind: BillingAuthKind;
  principalBucket: BillingPrincipalBucket;
  billingTag: BillingTag | null;
  operationId: string | null;
  requestPurpose: BillingLlmRequestPurpose;
  provider: string;
  requestModel: string;
  observedResponseModel: string | null;
  model: string;
  providerRequestId: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  promptTokensTotal: number | null;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWriteUnspecifiedTokens: number;
  outputTokens: number;
  inputCostMicros: number | null;
  cachedInputCostMicros: number | null;
  cacheWrite5mCostMicros: number | null;
  cacheWrite1hCostMicros: number | null;
  cacheWriteUnspecifiedCostMicros: number | null;
  outputCostMicros: number | null;
  costMicros: number | null;
  currency: "USD";
  ratedAt: string;
  pricingStatus: LlmPricingStatus;
  unknownReason: string | null;
  estimateBasis: "public_list_placeholder" | "contract" | null;
  estimateLabel: string | null;
  contextTier: LlmPricingContextTier;
  pricingVersion: string;
  rateCardDigest: string | null;
  pricingSourceUrl: string | null;
  pricingSourceAsOf: string | null;
  pricingEffectiveAt: string;
  pricingEffectiveToExclusive: string | null;
  deploymentBillingJson: unknown | null;
  rateSnapshotJson: unknown | null;
  valuationStatus: BillingValuationStatus;
}

export interface UserSandboxUsage {
  kind: "sandbox";
  id: string;
  occurredAt: string;
  organizationId: string;
  sessionId: string;
  turnId: string;
  agentRunId: string | null;
  agentId: string | null;
  attributionKind: BillingAttributionKind;
  ownerUserId: string | null;
  authKind: BillingAuthKind;
  principalBucket: BillingPrincipalBucket;
  billingTag: BillingTag | null;
  provider: "e2b" | "tencent_ags" | "run9";
  profileId: string;
  specKey: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  status: SandboxUsageStatus;
  closeReason: string | null;
  lastError: string | null;
  costMicros: number | null;
  currency: "USD";
  pricingVersion: string;
  pricingEffectiveAt: string;
  valuationStatus: BillingValuationStatus;
}

export interface UserWebSearchUsage {
  kind: "web_search";
  id: string;
  occurredAt: string;
  organizationId: string;
  sessionId: string;
  turnId: string;
  agentRunId: string | null;
  agentId: string | null;
  ownerUserId: string | null;
  attributionKind: BillingAttributionKind;
  authKind: BillingAuthKind;
  principalBucket: BillingPrincipalBucket;
  billingTag: BillingTag | null;
  operationId: string;
  searchType: "auto";
  requestCount: 1;
  requestedResultCount: number;
  returnedResultCount: number | null;
  pricingStatus: "unpriced";
  unknownReason: "no_rate_authority";
  valuationStatus: "unpriced";
}

export interface UserUsageDetails {
  scope: UserUsageScope;
  range: UserUsageRange;
  llm: UserLlmUsage[];
  sandbox: UserSandboxUsage[];
  webSearch: UserWebSearchUsage[];
}

export interface OrganizationUserUsageSummary {
  range: BillingUsageSeriesRange;
  factCompleteness: BillingFactCompleteness;
  totals: UsageTotals;
  llm: { aggregates: LlmUsageAggregate[] };
  sandbox: { aggregates: SandboxUsageAggregate[] };
  webSearch: { aggregates: WebSearchUsageAggregate[] };
  series: BillingUsageSeriesPoint[];
}

interface OrganizationUsageCommon {
  id: string;
  occurredAt: string;
  sessionId: string;
  /** Null only when `kind=llm` and `requestPurpose=voice_realtime`. */
  turnId: string | null;
  /** The Realtime connection of `voice_realtime` usage; null otherwise. */
  realtimeConnectionId?: string | null;
  agentRunId: string | null;
  agentId: string | null;
  attributionKind: BillingAttributionKind;
  costMicros: number | null;
  currency: string | null;
  pricingVersion: string;
  pricingEffectiveAt: string;
  valuationStatus: BillingValuationStatus;
  valuationReason: string | null;
  rateCardDigest: string | null;
  billingTag: BillingTag | null;
}

export interface OrganizationLlmUsage extends OrganizationUsageCommon {
  kind: "llm";
  realtimeConnectionId: string | null;
  operationId: string | null;
  requestPurpose: BillingLlmRequestPurpose;
  provider: string;
  model: string;
  observedResponseModel: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWriteUnspecifiedTokens: number;
  outputTokens: number;
  inputCostMicros: number | null;
  cachedInputCostMicros: number | null;
  cacheWrite5mCostMicros: number | null;
  cacheWrite1hCostMicros: number | null;
  cacheWriteUnspecifiedCostMicros: number | null;
  outputCostMicros: number | null;
  pricingStatus: LlmPricingStatus;
  estimateBasis: "public_list_placeholder" | "contract" | null;
  contextTier: LlmPricingContextTier;
}

export interface OrganizationSandboxUsage extends OrganizationUsageCommon {
  kind: "sandbox";
  turnId: string;
  provider: "e2b" | "tencent_ags" | "run9";
  profileId: string;
  specKey: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  status: SandboxUsageStatus;
}

export interface OrganizationWebSearchUsage extends OrganizationUsageCommon {
  kind: "web_search";
  turnId: string;
  operationId: string;
  provider: "exa";
  searchType: "auto";
  requestCount: 1;
  requestedResultCount: number;
  returnedResultCount: number | null;
  contentTextRequested: true;
  requestOutcome: "succeeded" | "failed" | "aborted";
  usageEvidenceStatus: BillingUsageEvidenceStatus;
}

export type OrganizationUsageItem =
  | OrganizationLlmUsage
  | OrganizationSandboxUsage
  | OrganizationWebSearchUsage;

export interface OrganizationUserUsageDetails {
  items: OrganizationUsageItem[];
  nextCursor: string | null;
  factCompleteness: BillingFactCompleteness;
}

export interface UserUsageOptions extends RequestOptions {
  period?: "day" | "week";
  /** Inclusive UTC date, YYYY-MM-DD. */
  from?: string;
  /** Inclusive UTC date, YYYY-MM-DD. */
  to?: string;
  tagKey?: string;
  tagValue?: string;
}
export interface UserUsageDetailsOptions extends UserUsageOptions {
  /** Maximum rows per kind, 1-500; this endpoint has no continuation cursor. */
  limit?: number;
}
export interface OrganizationUserUsageOptions extends RequestOptions {
  /** Exact inclusive UTC timestamp with milliseconds; maximum range is 31 days. */
  from: string;
  /** Exact exclusive UTC timestamp with milliseconds. */
  to: string;
  interval?: BillingUsageSeriesInterval;
  tagKey?: string;
  tagValue?: string;
}
export interface OrganizationUserUsageDetailsOptions extends Omit<
  OrganizationUserUsageOptions,
  "interval"
> {
  kind?: BillingUsageFactKind;
  limit?: number;
  cursor?: string;
}

export const usageQuery = (
  options: object,
  allowed: readonly string[],
): string => {
  requireKnownKeys(
    options,
    [...allowed, "signal", "requestId"],
    "Usage options",
  );
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options))
    if (allowed.includes(key) && value !== undefined)
      query.set(key, String(value));
  return query.size ? `?${query}` : "";
};

export const userUsagePath = (
  userId: string,
  options: { from: string; to: string },
): string => {
  if (typeof userId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(userId))
    throw new TypeError("Organization usage requires an explicit User ID");
  if (
    typeof options?.from !== "string" ||
    !options.from ||
    typeof options.to !== "string" ||
    !options.to
  )
    throw new TypeError(
      "Organization usage requires from and to UTC timestamps",
    );
  return `/api/v1/org/users/${encodeURIComponent(userId)}/billing/usage`;
};
