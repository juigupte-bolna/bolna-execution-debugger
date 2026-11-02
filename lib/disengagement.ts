import type { ConversationPair, DisengagementSignal } from "./types";

// Hindi/Hinglish/English phrases that indicate the caller wants to end the
// call or hand it off — devanagari and romanized both, since Bolna scripts
// (like this one) mix both within a single line.
const GOODBYE_PATTERNS: RegExp[] = [
  /\bbye\b/i,
  /\bband\s*karo\b/i,
  /\brakh(t[ीि]|o|ूं|ta|na)\b.*\bphone\b/i,
  /फ़?ोन\s*रख/,
  /रखती\s*हूं/,
  /रखता\s*हूं/,
  /call\s*mat\s*karo/i,
  /\bdisconnect\b/i,
  /\bhang\s*up\b/i,
  /\bgoodbye\b/i,
  /अलविदा/,
  /\bnahi\s*chahiye\b/i,
  /नहीं\s*चाहिए/,
  /\brakhna\s*hai\b/i,
];

const DISINTEREST_PATTERNS: RegExp[] = [
  /\bnot\s*interested\b/i,
  /interested\s*nahi/i,
  /\bबस\s*ठीक\s*है\b/,
  /\bbusy\s*(hoon|hun)\b/i,
  /व्यस्त\s*हूं/,
  /\babhi\s*nahi\b/i,
  /\bबाद\s*में\s*बात\b/,
  /\btime\s*nahi\s*hai\b/i,
  /समय\s*नहीं\s*है/,
  /पता\s*नहीं/,
  /\bnahi\s*pata\b/i,
  /\bwhatever\b/i,
  /\bjo\s*bhi\b/i,
  /\bkoi\s*(zaroorat|jarurat)\s*nahi\b/i,
  /कोई\s*ज़रूरत\s*नहीं/,
];

const OBJECTION_PATTERNS: RegExp[] = [
  /\bmehnga\b/i,
  /\bmehenga\b/i,
  /महंगा/,
  /\bfraud\b/i,
  /\bscam\b/i,
  /already\s*(le\s*rakha|liya)/i,
  /पहले\s*ही\s*ले/,
  /\btrust\s*nahi\b/i,
  /भरोसा\s*नहीं/,
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Deterministic, no-API-key pass over the reconstructed conversation.
 * Flags goodbye/disinterest/objection phrasing and runs of very short
 * user replies (a classic sign of a caller checking out of the call).
 */
export function scanForDisengagement(pairs: ConversationPair[]): DisengagementSignal[] {
  const signals: DisengagementSignal[] = [];

  let shortStreak = 0;
  let streakStartTurn: number | null = null;

  for (const pair of pairs) {
    const text = pair.user;

    if (matchesAny(GOODBYE_PATTERNS, text)) {
      signals.push({
        turn: pair.turn,
        type: "goodbye",
        quote: text,
        note: "Caller used goodbye/end-call phrasing.",
      });
    } else if (matchesAny(OBJECTION_PATTERNS, text)) {
      signals.push({
        turn: pair.turn,
        type: "objection",
        quote: text,
        note: "Caller raised an objection (price, trust, already covered).",
      });
    } else if (matchesAny(DISINTEREST_PATTERNS, text)) {
      signals.push({
        turn: pair.turn,
        type: "disinterest",
        quote: text,
        note: "Caller expressed disinterest or unavailability.",
      });
    }

    const wc = wordCount(text);
    if (wc > 0 && wc <= 2) {
      if (shortStreak === 0) streakStartTurn = pair.turn;
      shortStreak++;
    } else {
      if (shortStreak >= 3 && streakStartTurn !== null) {
        signals.push({
          turn: streakStartTurn,
          type: "short_answer_streak",
          quote: pairs.find((p) => p.turn === streakStartTurn)?.user ?? "",
          note: `${shortStreak} consecutive one-to-two-word replies starting here — possible drop in engagement.`,
        });
      }
      shortStreak = 0;
      streakStartTurn = null;
    }
  }
  if (shortStreak >= 3 && streakStartTurn !== null) {
    signals.push({
      turn: streakStartTurn,
      type: "short_answer_streak",
      quote: pairs.find((p) => p.turn === streakStartTurn)?.user ?? "",
      note: `${shortStreak} consecutive one-to-two-word replies through the end of the call — possible drop in engagement.`,
    });
  }

  return signals.sort((a, b) => a.turn - b.turn);
}
