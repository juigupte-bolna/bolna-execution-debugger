import type { ConversationPair, ExtractedPromptContext, RawLogResponse } from "./types";

interface LinearTurn {
  speaker: "user" | "assistant";
  text: string;
}

/**
 * The last `llm` request entry in the raw log carries the full context the
 * model saw for its final turn: the system prompt followed by the entire
 * conversation so far, formatted as line-prefixed "system:" / "user:" /
 * "assistant:" blocks. That single string is more reliable than stitching
 * transcriber + synthesizer entries together (llm/response entries can
 * contain non-spoken JSON tool-trigger payloads instead of speech).
 */
export function extractPromptAndConversation(logs: RawLogResponse | null): ExtractedPromptContext {
  const empty: ExtractedPromptContext = { systemPrompt: null, pairs: [] };
  if (!logs?.data) return empty;

  const llmRequests = logs.data.filter(
    (e) => e.component === "llm" && e.type === "request" && typeof e.data === "string"
  );
  if (llmRequests.length === 0) return empty;

  const raw = llmRequests[llmRequests.length - 1].data as string;
  const lines = raw.split("\n");

  // Everything from line 0 up to the first line that is exactly a
  // "user:"/"assistant:" turn marker belongs to the system prompt.
  let boundary = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (/^(user|assistant):\s?/.test(lines[i])) {
      boundary = i;
      break;
    }
  }

  const systemBlock = lines.slice(0, boundary).join("\n");
  const systemPrompt = systemBlock.replace(/^system:\s?/, "").trim() || null;

  const linear: LinearTurn[] = [];
  for (const line of lines.slice(boundary)) {
    const match = line.match(/^(user|assistant):\s?(.*)$/);
    if (match) {
      linear.push({ speaker: match[1] as "user" | "assistant", text: match[2] });
    } else if (linear.length > 0) {
      // continuation of a multi-line turn
      linear[linear.length - 1].text += `\n${line}`;
    }
  }
  for (const t of linear) t.text = t.text.trim();

  let openingLine: string | undefined;
  let start = 0;
  if (linear[0]?.speaker === "assistant") {
    openingLine = linear[0].text;
    start = 1;
  }

  const pairs: ConversationPair[] = [];
  let turn = 0;
  for (let i = start; i < linear.length; i++) {
    if (linear[i].speaker !== "user") continue;
    turn++;
    const userText = linear[i].text;
    const next = linear[i + 1];
    const assistantText = next?.speaker === "assistant" ? next.text : undefined;
    pairs.push({ turn, user: userText, assistant: assistantText });
    if (assistantText) i++;
  }

  // The context embedded in the last llm/request entry only includes turns
  // that existed *before* that request was made — so the reply generated
  // *from* that request (often the call's closing line) is missing. Backfill
  // it from the last synthesizer response actually spoken in the call.
  const lastPair = pairs[pairs.length - 1];
  if (lastPair && !lastPair.assistant) {
    const lastSpoken = [...logs.data]
      .reverse()
      .find((e) => e.component === "synthesizer" && e.type === "response" && typeof e.data === "string");
    if (lastSpoken) {
      lastPair.assistant = (lastSpoken.data as string).trim();
    }
  }

  return { systemPrompt, openingLine, pairs };
}
