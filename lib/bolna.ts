import type { BolnaExecution, RawLogResponse } from "./types";

const API_BASE = "https://api.bolna.ai";

export class BolnaApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "BolnaApiError";
  }
}

async function bolnaGet<T>(path: string): Promise<T> {
  const apiKey = process.env.BOLNA_API_KEY;
  if (!apiKey) {
    throw new BolnaApiError(
      "BOLNA_API_KEY is not set on the server. Add it in your Vercel project's Environment Variables.",
      500
    );
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    let message = `Bolna API returned ${res.status}`;
    try {
      const body = await res.json();
      message = (body?.message as string) || (body?.error as string) || JSON.stringify(body);
    } catch {
      // ignore, fall back to default message
    }
    throw new BolnaApiError(message, res.status);
  }

  return (await res.json()) as T;
}

export function fetchExecution(executionId: string): Promise<BolnaExecution> {
  return bolnaGet<BolnaExecution>(`/executions/${encodeURIComponent(executionId)}`);
}

export function fetchExecutionLogs(executionId: string): Promise<RawLogResponse> {
  return bolnaGet<RawLogResponse>(`/executions/${encodeURIComponent(executionId)}/log`);
}
