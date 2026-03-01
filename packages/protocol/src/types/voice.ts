/**
 * Voice types for real-time speech interaction via GPU worker.
 */

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "interrupted";

export interface VoiceConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly codec: "opus" | "pcm";
  readonly opusBitrate?: number;
}

export interface VoiceClientMessage {
  readonly type: "audio" | "control";
  readonly audio?: Uint8Array;
  readonly control?: {
    readonly action: "start" | "stop" | "interrupt" | "config";
    readonly config?: Partial<VoiceConfig>;
  };
}

export interface VoiceServerMessage {
  readonly type: "audio" | "transcript" | "state" | "error";
  readonly audio?: Uint8Array;
  readonly transcript?: string;
  readonly state?: VoiceState;
  readonly error?: string;
}

export interface VADConfig {
  readonly endpointingDelayMs: number;
  readonly speechThreshold: number;
  readonly minSpeechDurationMs: number;
  readonly maxSpeechDurationMs: number;
}
