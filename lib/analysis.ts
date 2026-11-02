import type {
  ConversationPair,
  DiagnosisResult,
  DisengagementSignal,
  DisinterestMoment,
  QualityAnalysis,
} from "./types";

const ANTHROPIC_MODEL = "claude-sonnet-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const MAX_SYSTEM_PROMPT_CHARS = 6000;

function formatConversation(pairs: ConversationPair[]): string {
  if (pairs.length === 0) return "(no conversation reconstructed from raw logs)";
  return pairs
    .map((p) => `Turn ${p.turn}:\n  user: ${p.user}\n  assistant: ${p.assistant ?? "(no reply logged)"}`)
    .join("\n");
}

function formatRuleSignals(signals: DisengagementSignal[]): string {
  if (signals.length === 0) return "(none detected by keyword scan)";
  return signals.map((s) => `- turn ${s.turn} [${s.type}]: "${s.quote}" — ${s.note}`).join("\n");
}

// Shared JSON Schema — both Anthropic (input_schema) and OpenAI (parameters)
// take a plain JSON Schema object for a forced tool/function call.
const ANALYSIS_TOOL_NAME = "submit_call_analysis";
const ANALYSIS_TOOL_DESCRIPTION =
  "Structured diagnosis of this voice-agent call: a short technical root-cause note plus a conversational-quality verdict, the turn where the caller checked out (if any), and concrete prompt edits to fix it.";

const ANALYSIS_SCHEMA = {
  type: "object" as const,
  properties: {
    technical_summary: {
      type: "string",
      description:
        "Max 80 words. The most likely technical root cause from latency/hangup/error data, or 'No technical issue found.' if the pipeline looks healthy.",
    },
    call_verdict: {
      type: "string",
      enum: ["good", "mixed", "poor"],
      description: "Overall call quality: did it achieve what the agent was trying to do.",
    },
    verdict_reason: {
      type: "string",
      description: "Max 40 words explaining the verdict.",
    },
    drop_off_detected: {
      type: "boolean",
      description: "True if there's a clear turn where the caller's engagement dropped or they tried to end the call.",
    },
    drop_off_turn: {
      type: "integer",
      description: "The turn number (matching the provided turn numbering) where drop-off happened. Omit if drop_off_detected is false.",
    },
    drop_off_quote: {
      type: "string",
      description: "The caller's exact words at the drop-off point. Omit if drop_off_detected is false.",
    },
    disinterest_moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          turn: { type: "integer" },
          quote: { type: "string" },
          signal_type: {
            type: "string",
            enum: ["disinterest", "goodbye", "impatience", "confusion", "objection"],
          },
          explanation: { type: "string", description: "Max 25 words." },
        },
        required: ["turn", "quote", "signal_type", "explanation"],
      },
      description: "Every moment the caller showed reduced engagement, impatience, confusion, or an objection — beyond what the keyword scan already found, if any.",
    },
    prompt_fix_suggestions: {
      type: "array",
      items: { type: "string" },
      description:
        "Concrete, specific edits to the system prompt below that would prevent the identified drop-off/disinterest next time. Reference the actual section or line you'd change, not generic advice. Empty array if the prompt isn't the issue.",
    },
  },
  required: [
    "technical_summary",
    "call_verdict",
    "verdict_reason",
    "drop_off_detected",
    "disinterest_moments",
    "prompt_fix_suggestions",
  ],
};

interface RawAnalysisInput {
  technical_summary: string;
  call_verdict: "good" | "mixed" | "poor";
  verdict_reason: string;
  drop_off_detected: boolean;
  drop_off_turn?: number;
  drop_off_quote?: string;
  disinterest_moments?: {
    turn: number;
    quote: string;
    signal_type: string;
    explanation: string;
  }[];
  prompt_fix_suggestions?: string[];
}

function toQualityAnalysis(input: RawAnalysisInput): QualityAnalysis {
  const disinterestMoments: DisinterestMoment[] = (input.disinterest_moments ?? []).map((m) => ({
    turn: m.turn,
    quote: m.quote,
    signalType: m.signal_type,
    explanation: m.explanation,
  }));

  return {
    technicalSummary: input.technical_summary,
    verdict: input.call_verdict,
    verdictReason: input.verdict_reason,
    dropOffDetected: input.drop_off_detected,
    dropOffTurn: input.drop_off_turn,
    dropOffQuote: input.drop_off_quote,
    disinterestMoments,
    promptFixSuggestions: input.prompt_fix_suggestions ?? [],
  };
}

function buildPrompt(
  diagnosis: DiagnosisResult,
  systemPrompt: string | null,
  pairs: ConversationPair[],
  ruleSignals: DisengagementSignal[]
): string {
  const truncatedPrompt = systemPrompt
    ? systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
      ? `${systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS)}\n[...truncated...]`
      : systemPrompt
    : "(system prompt not available in raw logs)";

  return `You are debugging a Bolna voice-agent call — a Hindi/Hinglish/English outbound lead-qualification or support call. Analyze whether the call went well and, if the caller lost interest or tried to end the call early, pinpoint exactly where and suggest a concrete prompt fix.

RULE-BASED FINDINGS (technical):
${diagnosis.findings.map((f) => `- [${f.severity}] ${f.title} — ${f.detail}`).join("\n")}

LATENCY (turn 1): transcriber=${diagnosis.latencySummary.firstTurn.transcriberMs}ms (${diagnosis.latencySummary.firstTurn.transcriberStatus}), llm=${diagnosis.latencySummary.firstTurn.llmMs}ms (${diagnosis.latencySummary.firstTurn.llmStatus}), synth=${diagnosis.latencySummary.firstTurn.synthMs}ms (${diagnosis.latencySummary.firstTurn.synthStatus})

STATUS: ${diagnosis.status}${diagnosis.errorMessage ? ` (${diagnosis.errorMessage})` : ""}
HANGUP: by=${diagnosis.telephony.hangupBy ?? "?"} reason=${diagnosis.telephony.hangupReason ?? "?"}

KEYWORD-SCAN SIGNALS (already detected without AI — confirm, extend, or correct these):
${formatRuleSignals(ruleSignals)}

CONVERSATION (turn numbers match the latency table above):
${formatConversation(pairs)}

SYSTEM PROMPT ACTUALLY USED FOR THIS CALL:
${truncatedPrompt}`;
}

async function analyzeWithAnthropic(
  apiKey: string,
  prompt: string
): Promise<{ quality?: QualityAnalysis; analysisError?: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        tools: [
          {
            name: ANALYSIS_TOOL_NAME,
            description: ANALYSIS_TOOL_DESCRIPTION,
            input_schema: ANALYSIS_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { analysisError: `Anthropic API returned ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = await res.json();
    const toolUse = (json?.content as { type: string; input?: unknown }[] | undefined)?.find(
      (block) => block.type === "tool_use"
    );
    if (!toolUse?.input) {
      return { analysisError: "Anthropic response did not include a structured analysis." };
    }

    return { quality: toQualityAnalysis(toolUse.input as RawAnalysisInput) };
  } catch (err) {
    return { analysisError: err instanceof Error ? err.message : "Unknown error calling Anthropic API" };
  }
}

async function analyzeWithOpenAI(
  apiKey: string,
  prompt: string
): Promise<{ quality?: QualityAnalysis; analysisError?: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            type: "function",
            function: {
              name: ANALYSIS_TOOL_NAME,
              description: ANALYSIS_TOOL_DESCRIPTION,
              parameters: ANALYSIS_SCHEMA,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: ANALYSIS_TOOL_NAME } },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { analysisError: `OpenAI API returned ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = await res.json();
    const toolCall = json?.choices?.[0]?.message?.tool_calls?.[0];
    const argsRaw = toolCall?.function?.arguments as string | undefined;
    if (!argsRaw) {
      return { analysisError: "OpenAI response did not include a structured analysis." };
    }

    let input: RawAnalysisInput;
    try {
      input = JSON.parse(argsRaw);
    } catch {
      return { analysisError: "OpenAI returned malformed JSON for the structured analysis." };
    }

    return { quality: toQualityAnalysis(input) };
  } catch (err) {
    return { analysisError: err instanceof Error ? err.message : "Unknown error calling OpenAI API" };
  }
}

/**
 * Optional enrichment: if ANTHROPIC_API_KEY or OPENAI_API_KEY is set, ask the
 * model to read the reconstructed conversation + actual system prompt used
 * for this call and produce a structured quality/drop-off/prompt-fix
 * analysis via a forced tool/function call. Anthropic is preferred when both
 * are present. Never throws — callers should treat a missing analysis as fine.
 */
export async function generateAnalysis(
  diagnosis: DiagnosisResult,
  systemPrompt: string | null,
  pairs: ConversationPair[],
  ruleSignals: DisengagementSignal[]
): Promise<{ quality?: QualityAnalysis; analysisError?: string }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return {};

  const prompt = buildPrompt(diagnosis, systemPrompt, pairs, ruleSignals);

  if (anthropicKey) return analyzeWithAnthropic(anthropicKey, prompt);
  return analyzeWithOpenAI(openaiKey as string, prompt);
}
