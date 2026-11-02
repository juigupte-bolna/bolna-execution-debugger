import type {
  BolnaExecution,
  DiagnosisResult,
  Finding,
  LatencyStatus,
  RawLogResponse,
  ToolCallSummary,
  TurnLatencyRow,
} from "./types";
import { extractPromptAndConversation } from "./conversation";
import { scanForDisengagement } from "./disengagement";

// Thresholds pulled from the debug-bolna-calls skill's latency-metrics reference.
const THRESHOLDS = {
  audioToText: { healthy: 50, concerning: 100 },
  llmTtft: { healthy: 500, concerning: 1000 },
  synthTtft: { healthy: 300, concerning: 500 },
};

function classify(value: number | null | undefined, healthy: number, concerning: number): LatencyStatus {
  if (value === null || value === undefined) return "—";
  if (value <= healthy) return "OK";
  if (value <= concerning) return "WARN";
  return "BAD";
}

// error_message substring -> human fix, from the debug skill's clue table.
const ERROR_MESSAGE_CLUES: { match: string; fix: string }[] = [
  { match: "not owned by account", fix: "Use a phone number you actually own. Check GET /phone-numbers/all." },
  { match: "invalid phone number", fix: "Use E.164 format, e.g. +91XXXXXXXXXX — not 91... or 091..." },
  { match: "disallowed content", fix: "Bolna's content checker flagged the prompt. Review and re-save the agent." },
  { match: "concurrency limit", fix: "You're at your concurrency cap. Wait for a slot or upgrade the account." },
  { match: "provider auth failed", fix: "Re-add the provider's credentials (Twilio/Plivo/etc.)." },
];

function firstFinalLatency(seqs: { audio_to_text_latency: number }[] | undefined): number | null {
  if (!seqs || seqs.length === 0) return null;
  return seqs[seqs.length - 1]?.audio_to_text_latency ?? null;
}

export function diagnoseExecution(
  execution: BolnaExecution,
  logs: RawLogResponse | null
): DiagnosisResult {
  const findings: Finding[] = [];

  const tel = execution.telephony_data || {};
  const lat = execution.latency_data || {};
  const transcriberTurns = lat.transcriber?.turns || [];
  const llmTurns = lat.llm?.turns || [];
  const synthTurns = lat.synthesizer?.turns || [];

  const turnCount = Math.max(transcriberTurns.length, llmTurns.length, synthTurns.length);
  const turnLatencies: TurnLatencyRow[] = [];

  for (let i = 0; i < turnCount; i++) {
    const transcriberMs = firstFinalLatency(transcriberTurns[i]?.turn_latency);
    const llmMs = llmTurns[i]?.time_to_first_token ?? null;
    const synthMs = synthTurns[i]?.time_to_first_token ?? null;

    turnLatencies.push({
      turn: i + 1,
      transcriberMs,
      transcriberStatus: classify(transcriberMs, THRESHOLDS.audioToText.healthy, THRESHOLDS.audioToText.concerning),
      llmMs,
      llmStatus: classify(llmMs, THRESHOLDS.llmTtft.healthy, THRESHOLDS.llmTtft.concerning),
      synthMs,
      synthStatus: classify(synthMs, THRESHOLDS.synthTtft.healthy, THRESHOLDS.synthTtft.concerning),
    });
  }

  const firstTurn = turnLatencies[0] ?? {
    transcriberMs: null,
    transcriberStatus: "—" as LatencyStatus,
    llmMs: null,
    llmStatus: "—" as LatencyStatus,
    synthMs: null,
    synthStatus: "—" as LatencyStatus,
  };

  // --- Findings: status / account ---
  if (execution.status === "balance-low") {
    findings.push({
      severity: "critical",
      title: "Account wallet balance too low",
      detail: "Calls will keep landing in balance-low until the wallet is topped up. Check GET /user/me.wallet.",
    });
  }

  if ((execution.status === "failed" || execution.status === "error") && execution.error_message) {
    const clue = ERROR_MESSAGE_CLUES.find((c) => execution.error_message!.toLowerCase().includes(c.match));
    findings.push({
      severity: "critical",
      title: `Execution ${execution.status}: ${execution.error_message}`,
      detail: clue ? clue.fix : "Inspect raw logs and agent config for the root cause.",
    });
  }

  // --- Findings: latency ---
  const bottlenecks = turnLatencies.filter(
    (t) => t.llmStatus === "BAD" || t.transcriberStatus === "BAD" || t.synthStatus === "BAD"
  );
  if (firstTurn.llmStatus === "BAD") {
    findings.push({
      severity: "warning",
      title: `LLM time-to-first-token is slow (${firstTurn.llmMs}ms on turn 1)`,
      detail: "Above the 1000ms concerning threshold. Try a faster model (e.g. Azure gpt-4.1-mini), shorten the prompt, or check provider health.",
    });
  }
  if (firstTurn.transcriberStatus === "BAD") {
    findings.push({
      severity: "warning",
      title: `Transcriber latency is slow (${firstTurn.transcriberMs}ms on turn 1)`,
      detail: "Above the 100ms concerning threshold. Switch transcriber provider, check audio quality, or verify network to the STT provider.",
    });
  }
  if (firstTurn.synthStatus === "BAD") {
    findings.push({
      severity: "warning",
      title: `Synthesizer first-audio is slow (${firstTurn.synthMs}ms on turn 1)`,
      detail: "Above the 500ms concerning threshold. Switch TTS provider/voice (e.g. ElevenLabs turbo_v2_5, Cartesia) or reduce buffer size.",
    });
  }
  if (bottlenecks.length > 1 && firstTurn.llmStatus !== "BAD" && firstTurn.transcriberStatus !== "BAD" && firstTurn.synthStatus !== "BAD") {
    findings.push({
      severity: "warning",
      title: `Latency issues appear on ${bottlenecks.length} later turn(s), not just turn 1`,
      detail: "This isn't just a cold-start problem — check the full turn-by-turn latency table below.",
    });
  }
  if (lat.time_to_first_audio && lat.time_to_first_audio > 3000) {
    findings.push({
      severity: "warning",
      title: `Time to first audio was very high (${Math.round(lat.time_to_first_audio)}ms)`,
      detail: "This is the headline number for perceived responsiveness on the very first turn.",
    });
  }

  // --- Findings: telephony / hangup ---
  if (tel.hangup_reason === "inactivity_timeout") {
    findings.push({
      severity: "warning",
      title: "Call hung up due to user silence",
      detail: "Consider raising task_config.hangup_after_silence (default 10s) if callers need more time to respond.",
    });
  }
  if (tel.hangup_by && tel.hangup_reason && tel.hangup_reason !== "inactivity_timeout") {
    findings.push({
      severity: "info",
      title: `Call ended: ${tel.hangup_by} hung up (${tel.hangup_reason})`,
      detail: tel.hangup_code ? `Hangup code: ${tel.hangup_code}` : "Cross-reference with hangup-code documentation if unexpected.",
    });
  }
  if (
    execution.status === "completed" &&
    typeof execution.conversation_duration === "number" &&
    execution.conversation_duration < 5 &&
    !execution.answered_by_voice_mail
  ) {
    findings.push({
      severity: "info",
      title: `Very short call (${execution.conversation_duration}s)`,
      detail: "Could be an immediate hangup, wrong number, or the agent's opening line didn't anchor the user. Check the transcript.",
    });
  }
  if (execution.answered_by_voice_mail) {
    findings.push({
      severity: "info",
      title: "Call was answered by voicemail",
      detail: "If a message should have been left, verify voicemail detection and the voicemail prompt in task_config.",
    });
  }

  // --- Findings: raw log derived ---
  // Note: function/tool invocations are logged with component "function_call"
  // (not "tool" as some docs suggest), and the function name lives inside the
  // JSON-encoded `data` string as `called_fun` rather than a top-level field.
  const toolCalls: ToolCallSummary[] = [];
  let reasoningTurnCount = 0;
  let lastRequestedFn: string | undefined;
  if (logs?.data) {
    for (const entry of logs.data) {
      if (entry.component === "function_call") {
        const preview = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data);
        let name: string | undefined;
        let looksLikeError = /error|fail|exception/i.test(preview);
        try {
          const parsed = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
          if (parsed && typeof parsed === "object") {
            if ("called_fun" in parsed) {
              name = String((parsed as Record<string, unknown>).called_fun);
              lastRequestedFn = name;
            }
            if ("status" in parsed && (parsed as Record<string, unknown>).status !== "success") {
              looksLikeError = true;
            }
          }
        } catch {
          // data wasn't JSON — keep the raw preview and substring-based error check
        }
        toolCalls.push({
          name: name ?? lastRequestedFn,
          type: entry.type,
          dataPreview: preview.slice(0, 300),
          looksLikeError,
        });
      }
      if (entry.component === "llm" && entry.type === "response" && entry.reasoning_content) {
        reasoningTurnCount++;
      }
    }
    const failedTools = toolCalls.filter((t) => t.looksLikeError);
    if (failedTools.length > 0) {
      findings.push({
        severity: "warning",
        title: `${failedTools.length} tool call(s) look like they failed`,
        detail: `Affected tool(s): ${[...new Set(failedTools.map((t) => t.name).filter(Boolean))].join(", ") || "unknown"}. See the tool calls section below.`,
      });
    }
  }

  // --- Conversation reconstruction + disengagement scan ---
  const { systemPrompt, pairs } = extractPromptAndConversation(logs);
  const disengagementSignals = scanForDisengagement(pairs);

  if (pairs.length === 0 && logs?.data?.some((e) => e.component === "synthesizer" && e.type === "response")) {
    findings.push({
      severity: "warning",
      title: "Caller never said anything before the call ended",
      detail:
        "The agent spoke (greeting/check-in) but no user speech was transcribed at all. Likely a wrong number, the caller wasn't ready, or they hung up before responding — not a technical failure. Check the recording to confirm.",
    });
  }
  for (const signal of disengagementSignals) {
    if (signal.type === "goodbye") {
      findings.push({
        severity: "warning",
        title: `Caller used goodbye/end-call phrasing at turn ${signal.turn}`,
        detail: `"${signal.quote}" — ${signal.note}`,
      });
    } else if (signal.type === "objection") {
      findings.push({
        severity: "info",
        title: `Caller raised an objection at turn ${signal.turn}`,
        detail: `"${signal.quote}" — ${signal.note}`,
      });
    } else if (signal.type === "disinterest") {
      findings.push({
        severity: "info",
        title: `Caller showed disinterest at turn ${signal.turn}`,
        detail: `"${signal.quote}" — ${signal.note}`,
      });
    } else if (signal.type === "short_answer_streak") {
      findings.push({
        severity: "info",
        title: `Caller's replies got noticeably shorter from turn ${signal.turn}`,
        detail: signal.note,
      });
    }
  }

  if (execution.extracted_data && Object.keys(execution.extracted_data).length === 0 && execution.status === "completed") {
    findings.push({
      severity: "info",
      title: "No extracted_data on a completed call",
      detail: "If dispositions are configured on this agent, verify they're set up and the call reached a state where they could fire.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      title: "No obvious issue found from execution + log scan",
      detail: "Latency, status, and hangup data all look healthy. Inspect the transcript and raw logs for content-level problems (wrong tool, wrong answer, off-script drift).",
    });
  }

  // Sort: critical first, then warning, then info.
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    executionId: execution.id,
    status: execution.status,
    errorMessage: execution.error_message,
    conversationDuration: execution.conversation_duration ?? execution.conversation_time,
    createdAt: execution.created_at,
    agentId: execution.agent_id,
    answeredByVoiceMail: execution.answered_by_voice_mail,
    telephony: {
      provider: tel.provider,
      duration: tel.duration,
      hangupBy: tel.hangup_by,
      hangupReason: tel.hangup_reason,
      hangupCode: tel.hangup_code,
      postDialDelay: tel.post_dial_delay,
      recordingUrlPresent: Boolean(tel.recording_url || execution.recording_url),
    },
    latencySummary: {
      timeToFirstAudioMs: lat.time_to_first_audio,
      region: lat.region,
      firstTurn: {
        transcriberMs: firstTurn.transcriberMs,
        transcriberStatus: firstTurn.transcriberStatus,
        llmMs: firstTurn.llmMs,
        llmStatus: firstTurn.llmStatus,
        synthMs: firstTurn.synthMs,
        synthStatus: firstTurn.synthStatus,
      },
    },
    turnLatencies,
    toolCalls,
    reasoningTurnCount,
    extractedDataKeys: Object.keys(execution.extracted_data || {}),
    transcript: execution.transcript,
    findings,
    conversation: pairs,
    systemPrompt: systemPrompt ?? undefined,
    disengagementSignals,
  };
}
