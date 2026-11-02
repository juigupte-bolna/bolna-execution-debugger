# Bolna Execution Debugger

Paste a Bolna `execution_id`, get back a one-page diagnosis covering two layers:

- **Technical**: latency bottlenecks (transcriber / LLM / synthesizer, per turn), hangup
  data, failed tool calls, account/error status.
- **Conversational**: was the call actually good or bad, where the caller lost interest
  or tried to end the call, and — if you set an Anthropic key — concrete edits to the
  system prompt that would fix it, grounded in the real prompt text used for that call.

Built as a small Next.js app so it deploys to Vercel with zero config.

## How it works

1. You submit an execution ID from the single input on the page.
2. The server route `app/api/diagnose/route.ts` calls Bolna's
   `GET /executions/{id}` and `GET /executions/{id}/log` using `BOLNA_API_KEY`
   (server-side only — never sent to the browser).
3. `lib/diagnose.ts` applies the same latency thresholds and symptom checks as
   Bolna's own debugging runbook (long silences, slow TTFT, silence hangups,
   `balance-low`, known `error_message` patterns, failed tool calls, etc.).
4. `lib/conversation.ts` reconstructs the actual conversation and the exact
   system prompt used for the call from the raw log's last `llm` request entry
   (which carries the full context the model saw), and backfills the closing
   line from the last `synthesizer` response.
5. `lib/disengagement.ts` runs a free, always-on keyword scan over the caller's
   turns for goodbye/disinterest/objection phrasing (Hindi, Hinglish, and
   English) and runs of very short replies — a classic sign of a caller
   checking out. These are **candidate signals**, not verdicts: short
   factual answers ("पता नहीं" to "what's your pincode?") can look identical
   to real disinterest in a pure keyword match.
6. If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, `lib/analysis.ts` sends
   the full conversation, the system prompt, and the keyword-scan candidates
   to the model via a forced tool/function call, asking it to
   confirm/correct/extend those candidates with real context, give an overall
   good/mixed/poor verdict, pinpoint the drop-off turn, and suggest specific
   prompt edits. Anthropic is used if both keys are set; otherwise OpenAI
   (`gpt-4o` by default — override with `OPENAI_MODEL`). This step is
   entirely optional — the app works fine without either key, just without
   the verdict and prompt-fix suggestions.

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local and set BOLNA_API_KEY (required), ANTHROPIC_API_KEY (optional)
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

```bash
npm install -g vercel   # if you don't already have it
vercel
```

Or connect the repo in the Vercel dashboard (New Project → import this repo).
Either way, before the first real request, set the environment variables in
**Project Settings → Environment Variables**:

| Variable | Required | Notes |
|---|---|---|
| `BOLNA_API_KEY` | Yes | From the Bolna dashboard → Developers. Server-side only. |
| `ANTHROPIC_API_KEY` | No | Enables the call-quality verdict, drop-off detection, and prompt-fix suggestions (preferred over OpenAI if both are set). |
| `OPENAI_API_KEY` | No | Same as above, used if `ANTHROPIC_API_KEY` isn't set. |
| `OPENAI_MODEL` | No | Overrides the OpenAI model (default `gpt-4o`). Ignored when using Anthropic. |

Omitting both AI keys still gives you the technical diagnosis + keyword-scan signals — just no verdict or prompt-fix suggestions.

Redeploy after adding env vars (`vercel --prod`, or push to the connected
branch) so the serverless functions pick them up.

## Notes

- Raw logs, transcripts, and the system prompt can contain PII (names, phone
  numbers, OTPs) and proprietary prompt content. This app doesn't persist
  anything — each request is fetched fresh and rendered client-side only for
  that session — but treat the deployed URL accordingly (e.g. put it behind
  Vercel's password protection / your own auth if it'll hold real customer
  call data).
- Latency thresholds (transcriber >100ms, LLM TTFT >1000ms, synth TTFT
  >500ms = "BAD") mirror Bolna's own debug-bolna-calls skill. Adjust them in
  `lib/diagnose.ts` if your use case has different tolerances.
- The raw-log field names used here (`component: "function_call"` for tool
  calls, `called_fun` inside its JSON `data`, `created_at` for timestamps)
  were verified against live executions — some of Bolna's own skill docs
  describe a slightly different shape (`component: "tool"`, `tool_name`,
  `timestamp`) that doesn't match what the API actually returns.
- The keyword scan's phrase lists live in `lib/disengagement.ts` — add
  patterns there if your agents use language it doesn't catch yet (e.g. other
  Indian languages).
