import { OutcomeUnknownError } from "./errors.js";

export type RealtimeLanguage = "zh-CN" | "en-US";
export type RealtimeEndpointingMode = "client" | "server";

export interface RealtimePcm16AudioFormat {
  encoding: "pcm16";
  sampleRate: number;
  channels: 1;
}

export interface RealtimeOpusAudioFormat {
  encoding: "opus";
  sampleRate: number;
  channels: 1;
  packetDurationMs: number;
  bitrate?: 16000 | 24000 | 32000;
}

export type RealtimeAudioFormat =
  | RealtimePcm16AudioFormat
  | RealtimeOpusAudioFormat;

export interface RealtimeModel {
  id: string;
  label: string;
  available: boolean;
  isDefault: boolean;
  languages: RealtimeLanguage[];
  endpointingModes: RealtimeEndpointingMode[];
  audio: {
    input: RealtimeAudioFormat[];
    output: RealtimeAudioFormat[];
  };
}

export interface RealtimeModelCatalog {
  defaultModel: string | null;
  models: RealtimeModel[];
}

export interface RealtimeVoiceSetting {
  language: RealtimeLanguage;
}

export interface RealtimeModelSelection {
  model: string | null;
  revision: number;
  etag: string;
  voice: RealtimeVoiceSetting | null;
}

export interface RealtimeSessionSelectionFields {
  realtimeModel: string | null;
  realtimeModelRevision: number;
  realtimeModelEtag: string;
  realtimeVoice: RealtimeVoiceSetting | null;
}

export const realtimeModelSelectionFrom = (
  session: RealtimeSessionSelectionFields,
): RealtimeModelSelection => ({
  model: session.realtimeModel,
  revision: session.realtimeModelRevision,
  etag: session.realtimeModelEtag,
  voice: session.realtimeVoice,
});

export interface RealtimeAudioFormats {
  input: RealtimeAudioFormat;
  output: RealtimeAudioFormat;
}

export interface OpenRealtimeConnectionInput {
  audio?: Partial<RealtimeAudioFormats>;
  metadata?: Record<string, string>;
}

export interface RealtimeConnection {
  object: "realtime_connection";
  id: string;
  sessionId: string;
  agentId: string;
  provider: {
    name: string;
    region: string | null;
    model: string | null;
  };
  status: "connecting" | "active" | "paused" | "ended";
  audio: RealtimeAudioFormats;
  activeTaskTurnId: string | null;
  usage: {
    inputAudioSec: number;
    outputAudioSec: number;
    thoughtTokens: number;
    textTokens: number;
  };
  metadata: Record<string, string>;
  createdAt: string;
  endedAt: string | null;
}

export interface RealtimeConnectGrant {
  websocketUrl: string;
  connectToken: string;
  connectTokenExpiresAt: string;
}

export interface OpenRealtimeConnectionResult extends RealtimeConnectGrant {
  realtimeConnection: RealtimeConnection;
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isAudioFormat = (value: unknown): value is RealtimeAudioFormat => {
  if (
    !isRecord(value) ||
    !isNumber(value.sampleRate) ||
    value.sampleRate <= 0 ||
    value.channels !== 1
  )
    return false;
  if (value.encoding === "pcm16") return true;
  return (
    value.encoding === "opus" &&
    Number.isInteger(value.packetDurationMs) &&
    isNumber(value.packetDurationMs) &&
    value.packetDurationMs > 0 &&
    (value.bitrate === undefined ||
      value.bitrate === 16000 ||
      value.bitrate === 24000 ||
      value.bitrate === 32000)
  );
};

const isRealtimeConnection = (value: unknown): value is RealtimeConnection => {
  if (!isRecord(value)) return false;
  const provider = value.provider;
  const audio = value.audio;
  const usage = value.usage;
  const metadata = value.metadata;
  return (
    value.object === "realtime_connection" &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isString(value.agentId) &&
    isRecord(provider) &&
    isString(provider.name) &&
    isNullableString(provider.region) &&
    isNullableString(provider.model) &&
    ["connecting", "active", "paused", "ended"].includes(
      String(value.status),
    ) &&
    isRecord(audio) &&
    isAudioFormat(audio.input) &&
    isAudioFormat(audio.output) &&
    isNullableString(value.activeTaskTurnId) &&
    isRecord(usage) &&
    isNumber(usage.inputAudioSec) &&
    isNumber(usage.outputAudioSec) &&
    Number.isInteger(usage.thoughtTokens) &&
    isNumber(usage.thoughtTokens) &&
    Number.isInteger(usage.textTokens) &&
    isNumber(usage.textTokens) &&
    isRecord(metadata) &&
    Object.values(metadata).every((entry) => typeof entry === "string") &&
    isDateTime(value.createdAt) &&
    (value.endedAt === null || isDateTime(value.endedAt))
  );
};

const isConnectGrant = (value: unknown): value is RealtimeConnectGrant => {
  if (!isRecord(value) || !isString(value.websocketUrl)) return false;
  let protocol: string;
  try {
    protocol = new URL(value.websocketUrl).protocol;
  } catch {
    return false;
  }
  return (
    (protocol === "ws:" || protocol === "wss:") &&
    typeof value.connectToken === "string" &&
    /^rct_[A-Za-z0-9_-]{43}$/u.test(value.connectToken) &&
    isDateTime(value.connectTokenExpiresAt)
  );
};

const unusableReceipt = (operation: string, requestId: string): never => {
  throw new OutcomeUnknownError(
    `TiDB Link accepted ${operation} but returned an unusable receipt`,
    { requestId },
  );
};

export const requireRealtimeModelSelectionReceipt = (
  value: unknown,
  requestId: string,
): RealtimeModelSelection => {
  if (!isRecord(value)) return unusableReceipt("the Realtime Model selection", requestId);
  const voice = value.realtimeVoice;
  if (
    !isNullableString(value.realtimeModel) ||
    !Number.isInteger(value.realtimeModelRevision) ||
    !isNumber(value.realtimeModelRevision) ||
    value.realtimeModelRevision <= 0 ||
    !isString(value.realtimeModelEtag) ||
    (voice !== null &&
      (!isRecord(voice) ||
        (voice.language !== "zh-CN" && voice.language !== "en-US")))
  )
    return unusableReceipt("the Realtime Model selection", requestId);
  return realtimeModelSelectionFrom(value as unknown as RealtimeSessionSelectionFields);
};

export const requireOpenRealtimeConnectionReceipt = (
  value: unknown,
  requestId: string,
): OpenRealtimeConnectionResult => {
  if (
    !isRecord(value) ||
    !isRealtimeConnection(value.realtimeConnection) ||
    !isConnectGrant(value)
  )
    return unusableReceipt("the Realtime Connection request", requestId);
  return value as unknown as OpenRealtimeConnectionResult;
};

export const requireRealtimeConnectGrantReceipt = (
  value: unknown,
  requestId: string,
): RealtimeConnectGrant => {
  if (!isConnectGrant(value))
    return unusableReceipt("the Realtime connect-token request", requestId);
  return value;
};

export const requireRealtimeConnectionReceipt = (
  value: unknown,
  requestId: string,
): RealtimeConnection => {
  if (!isRecord(value) || !isRealtimeConnection(value.realtimeConnection))
    return unusableReceipt("the Realtime Connection mutation", requestId);
  return value.realtimeConnection;
};
