"use client";

import { useState } from "react";
import type { DiagnosisResult, DisengagementSignal } from "@/lib/types";

export default function Home() {
  const [executionId, setExecutionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosisResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!executionId.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionId: executionId.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Something went wrong.");
      } else {
        setResult(json as DiagnosisResult);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <h1>Bolna Execution Debugger</h1>
      <p className="subtitle">
        Paste an execution ID to get a root-cause diagnosis: latency bottlenecks, hangups, tool failures, errors — plus where
        the caller lost interest or tried to end the call, and how to fix the prompt.
      </p>

      <form className="search-row" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="e.g. 8f2a1c3e-..."
          value={executionId}
          onChange={(e) => setExecutionId(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" disabled={loading || !executionId.trim()}>
          {loading ? "Analyzing…" : "Diagnose"}
        </button>
      </form>

      {loading && <p className="loading">Fetching execution + raw logs from Bolna…</p>}
      {error && <div className="error-box">{error}</div>}

      {result && <Diagnosis result={result} />}
    </div>
  );
}

function verdictLabel(v: string) {
  if (v === "good") return { text: "Good call", cls: "OK" };
  if (v === "poor") return { text: "Poor call", cls: "BAD" };
  return { text: "Mixed", cls: "WARN" };
}

function signalTurns(signals: DisengagementSignal[]): Set<number> {
  return new Set(signals.map((s) => s.turn));
}

function Diagnosis({ result }: { result: DiagnosisResult }) {
  const flaggedTurns = signalTurns(result.disengagementSignals);
  const quality = result.quality;

  return (
    <>
      <div className="card">
        <h2>Summary</h2>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="label">Status</div>
            <div className="value">{result.status ?? "—"}</div>
          </div>
          <div className="summary-item">
            <div className="label">Duration</div>
            <div className="value">{result.conversationDuration != null ? `${result.conversationDuration}s` : "—"}</div>
          </div>
          <div className="summary-item">
            <div className="label">Time to first audio</div>
            <div className="value">
              {result.latencySummary.timeToFirstAudioMs != null ? `${Math.round(result.latencySummary.timeToFirstAudioMs)}ms` : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Call Quality</h2>
        {quality ? (
          <>
            <div className="summary-grid" style={{ marginBottom: 16 }}>
              <div className="summary-item">
                <div className="label">Verdict</div>
                <div className="value">
                  <span className={`status-pill ${verdictLabel(quality.verdict).cls}`}>{verdictLabel(quality.verdict).text}</span>
                </div>
              </div>
              <div className="summary-item">
                <div className="label">Drop-off detected</div>
                <div className="value">{quality.dropOffDetected ? `Yes — turn ${quality.dropOffTurn ?? "?"}` : "No"}</div>
              </div>
            </div>
            <p style={{ margin: "0 0 10px" }}>{quality.verdictReason}</p>
            <p className="empty-note" style={{ margin: "0 0 10px" }}>{quality.technicalSummary}</p>
            {quality.dropOffDetected && quality.dropOffQuote && (
              <div className="finding warning">
                <div className="title">Drop-off at turn {quality.dropOffTurn}</div>
                <div className="detail">&ldquo;{quality.dropOffQuote}&rdquo;</div>
              </div>
            )}
          </>
        ) : result.analysisError ? (
          <p className="empty-note">AI analysis not available: {result.analysisError}</p>
        ) : (
          <p className="empty-note">
            Set ANTHROPIC_API_KEY to get a verdict, drop-off detection, and prompt-fix suggestions on top of the rule-based
            signals below.
          </p>
        )}
      </div>

      {quality && quality.disinterestMoments.length > 0 && (
        <div className="card">
          <h2>Disinterest Moments (AI)</h2>
          {quality.disinterestMoments.map((m, i) => (
            <div className="finding info" key={i}>
              <div className="title">
                Turn {m.turn} — {m.signalType}
              </div>
              <div className="detail">
                &ldquo;{m.quote}&rdquo; — {m.explanation}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>
          Disengagement Signals (keyword scan) {result.disengagementSignals.length > 0 && `(${result.disengagementSignals.length})`}
        </h2>
        {result.disengagementSignals.length === 0 ? (
          <p className="empty-note">No goodbye/disinterest/objection phrasing or short-answer streaks detected.</p>
        ) : (
          result.disengagementSignals.map((s, i) => (
            <div className={`finding ${s.type === "goodbye" ? "warning" : "info"}`} key={i}>
              <div className="title">
                Turn {s.turn} — {s.type.replace("_", " ")}
              </div>
              <div className="detail">
                &ldquo;{s.quote}&rdquo; — {s.note}
              </div>
            </div>
          ))
        )}
      </div>

      {quality && quality.promptFixSuggestions.length > 0 && (
        <div className="card">
          <h2>Prompt Fix Suggestions</h2>
          {quality.promptFixSuggestions.map((s, i) => (
            <div className="finding info" key={i}>
              <div className="detail">{s}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Likely Issues</h2>
        {result.findings.map((f, i) => (
          <div className={`finding ${f.severity}`} key={i}>
            <div className="title">{f.title}</div>
            <div className="detail">{f.detail}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Latency by Turn</h2>
        {result.turnLatencies.length === 0 ? (
          <p className="empty-note">No per-turn latency data on this execution.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Turn</th>
                <th>Transcriber</th>
                <th>LLM TTFT</th>
                <th>Synth TTFT</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {result.turnLatencies.map((t) => (
                <tr key={t.turn}>
                  <td>{t.turn}</td>
                  <td>
                    {t.transcriberMs != null ? `${Math.round(t.transcriberMs)}ms ` : "— "}
                    <span className={`status-pill ${t.transcriberStatus}`}>{t.transcriberStatus}</span>
                  </td>
                  <td>
                    {t.llmMs != null ? `${Math.round(t.llmMs)}ms ` : "— "}
                    <span className={`status-pill ${t.llmStatus}`}>{t.llmStatus}</span>
                  </td>
                  <td>
                    {t.synthMs != null ? `${Math.round(t.synthMs)}ms ` : "— "}
                    <span className={`status-pill ${t.synthStatus}`}>{t.synthStatus}</span>
                  </td>
                  <td>{flaggedTurns.has(t.turn) ? "⚠️" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Telephony</h2>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="label">Provider</div>
            <div className="value">{result.telephony.provider ?? "—"}</div>
          </div>
          <div className="summary-item">
            <div className="label">Hangup by</div>
            <div className="value">{result.telephony.hangupBy ?? "—"}</div>
          </div>
          <div className="summary-item">
            <div className="label">Hangup reason</div>
            <div className="value">{result.telephony.hangupReason ?? "—"}</div>
          </div>
          <div className="summary-item">
            <div className="label">Recording</div>
            <div className="value">{result.telephony.recordingUrlPresent ? "Available" : "None"}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Tool Calls {result.toolCalls.length > 0 && `(${result.toolCalls.length})`}</h2>
        {result.toolCalls.length === 0 ? (
          <p className="empty-note">No tool calls in this execution.</p>
        ) : (
          result.toolCalls.map((t, i) => (
            <div className={`tool-call ${t.looksLikeError ? "error" : ""}`} key={i}>
              <div className="name">
                {t.name ?? "unknown"} — {t.type}
              </div>
              <div>{t.dataPreview}</div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Conversation</h2>
        {result.conversation.length === 0 ? (
          result.transcript ? (
            <pre>{result.transcript}</pre>
          ) : (
            <p className="empty-note">No conversation could be reconstructed from raw logs, and no transcript is available.</p>
          )
        ) : (
          result.conversation.map((pair) => (
            <div
              key={pair.turn}
              style={{
                marginBottom: 14,
                paddingLeft: 10,
                borderLeft: flaggedTurns.has(pair.turn) ? "3px solid var(--warn)" : "3px solid transparent",
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 2 }}>
                Turn {pair.turn}
                {flaggedTurns.has(pair.turn) ? " ⚠️" : ""}
              </div>
              <div>
                <strong>User:</strong> {pair.user}
              </div>
              {pair.assistant && (
                <div>
                  <strong>Agent:</strong> {pair.assistant}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {result.systemPrompt && (
        <div className="card">
          <h2>System Prompt Used For This Call</h2>
          <pre>{result.systemPrompt}</pre>
        </div>
      )}
    </>
  );
}
