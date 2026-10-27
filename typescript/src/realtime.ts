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
