export interface LatencyTurn {
  turn: number;
  time_to_first_token?: number | null;
  time_to_last_token?: number | null;
  turn_latency?: { sequence_id: number; audio_to_text_latency: number; text?: string }[];
}

export interface LatencyData {
  stream_id?: number;
  time_to_first_audio?: number;
  region?: string;
  transcriber?: { time_to_connect?: number; turns?: LatencyTurn[] };
  llm?: { time_to_connect?: number | null; turns?: LatencyTurn[] };
  synthesizer?: { time_to_connect?: number; turns?: LatencyTurn[] };
}

export interface TelephonyData {
  provider?: string;
  duration?: number;
  recording_url?: string;
  hangup_by?: string;
  hangup_reason?: string;
  hangup_code?: string | number;
  post_dial_delay?: number;
  to_number?: string;
  from_number?: string;
  call_type?: string;
}

export interface BolnaExecution {
  id: string;
  agent_id?: string;
  batch_id?: string;
  status?: string;
  error_message?: string;
  conversation_time?: number;
  conversation_duration?: number;
  total_cost?: number;
  cost_breakdown?: Record<string, unknown>;
  answered_by_voice_mail?: boolean;
  transcript?: string;
  recording_url?: string;
  created_at?: string;
  updated_at?: string;
  telephony_data?: TelephonyData;
  transfer_call_data?: unknown;
  batch_run_details?: unknown;
  extracted_data?: Record<string, unknown>;
  context_details?: Record<string, unknown>;
  latency_data?: LatencyData;
  [key: string]: unknown;
}

export interface RawLogEntry {
  component?: string; // observed values: transcriber, synthesizer, llm, llm_language_detection, function_call, webhook
  type?: string; // request | response
  provider?: string;
  data?: unknown; // string for speech/prompt entries, sometimes a JSON-encoded string
  reasoning_content?: string;
  latency?: number; // seconds, present on some llm/response entries
  created_at?: string | null; // actual timestamp field name in the live API (docs call it "timestamp" — it isn't)
}

export interface RawLogResponse {
  execution_id?: string;
  data?: RawLogEntry[];
}

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

export type LatencyStatus = "OK" | "WARN" | "BAD" | "—";

export interface TurnLatencyRow {
  turn: number;
  transcriberMs: number | null;
  transcriberStatus: LatencyStatus;
  llmMs: number | null;
  llmStatus: LatencyStatus;
  synthMs: number | null;
  synthStatus: LatencyStatus;
}

export interface ToolCallSummary {
  name?: string;
  type?: string;
  dataPreview: string;
  looksLikeError: boolean;
}

// One user utterance + the agent's reply to it, numbered to match latency_data's
// turn indices (turn N in latency_data corresponds to the Nth user utterance).
export interface ConversationPair {
  turn: number;
  user: string;
  assistant?: string;
}

export interface ExtractedPromptContext {
  systemPrompt: string | null;
  openingLine?: string;
  pairs: ConversationPair[];
}

export type DisengagementType = "goodbye" | "disinterest" | "short_answer_streak" | "objection";

export interface DisengagementSignal {
  turn: number;
  type: DisengagementType;
  quote: string;
  note: string;
}

export type CallVerdict = "good" | "mixed" | "poor";

export interface DisinterestMoment {
  turn: number;
  quote: string;
  signalType: string;
  explanation: string;
}

export interface QualityAnalysis {
  technicalSummary: string;
  verdict: CallVerdict;
  verdictReason: string;
  dropOffDetected: boolean;
  dropOffTurn?: number;
  dropOffQuote?: string;
  disinterestMoments: DisinterestMoment[];
  promptFixSuggestions: string[];
}

export interface DiagnosisResult {
  executionId: string;
  status?: string;
  errorMessage?: string;
  conversationDuration?: number;
  createdAt?: string;
  agentId?: string;
  answeredByVoiceMail?: boolean;
  telephony: {
    provider?: string;
    duration?: number;
    hangupBy?: string;
    hangupReason?: string;
    hangupCode?: string | number;
    postDialDelay?: number;
    recordingUrlPresent: boolean;
  };
  latencySummary: {
    timeToFirstAudioMs?: number;
    region?: string;
    firstTurn: {
      transcriberMs: number | null;
      transcriberStatus: LatencyStatus;
      llmMs: number | null;
      llmStatus: LatencyStatus;
      synthMs: number | null;
      synthStatus: LatencyStatus;
    };
  };
  turnLatencies: TurnLatencyRow[];
  toolCalls: ToolCallSummary[];
  reasoningTurnCount: number;
  extractedDataKeys: string[];
  transcript?: string;
  findings: Finding[];
  conversation: ConversationPair[];
  systemPrompt?: string;
  disengagementSignals: DisengagementSignal[];
  quality?: QualityAnalysis;
  analysisError?: string;
}
