/**
 * AI attempt log (table ai_attempts) and the recent-call health shown on /admin/app.
 * Rows hold outcome codes and numbers only: never a prompt, customer text, reply or key.
 */
import type { Db } from "../db/pool.js";
import type { AttemptEvent } from "./provider.js";

export async function recordAiAttempt(db: Db, e: AttemptEvent): Promise<void> {
  await db.query(
    `INSERT INTO ai_attempts (call_id, provider, model, stage, attempt, final, ok, reason, latency_ms, input_tokens, output_tokens, cached_input_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [e.callId, e.provider.slice(0, 40), e.model.slice(0, 80), e.stage.slice(0, 40), e.attempt, e.final, e.ok, e.reason, Math.round(e.latencyMs),
      e.inputTokens, e.outputTokens, e.cachedInputTokens],
  );
}

export async function pruneAiAttempts(db: Db, days = 30): Promise<number> {
  const r = await db.query("DELETE FROM ai_attempts WHERE at < now() - make_interval(days => $1)", [days]);
  return r.rowCount ?? 0;
}

export interface AiModelStats {
  provider: string;
  model: string;
  attempts: number;
  ok: number;
  avgLatencyMs: number | null;
  p90LatencyMs: number | null;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorReason: string | null;
}
export interface AiCallStats {
  /** Calls = one generateJson (1 or 2 attempts); outcome = its final attempt. */
  calls: number;
  ok: number;
  answeredByRetry: number;
  lastCallAt: Date | null;
  lastFinalOk: boolean | null;
  lastErrorAt: Date | null;
  lastErrorReason: string | null;
}
export interface AiHealth {
  windowHours: number;
  calls: AiCallStats;
  models: AiModelStats[];
}

export type AiHealthState = "OK" | "DEGRADED" | "FAILING" | "NO_CALLS";

/** OK: >= 90 % of calls answered and the latest call answered. FAILING: < 50 % or the last 3 calls failed. */
export function healthState(c: AiCallStats, lastThreeFailed: boolean): AiHealthState {
  if (c.calls === 0) return "NO_CALLS";
  const rate = c.ok / c.calls;
  if (rate < 0.5 || lastThreeFailed) return "FAILING";
  if (rate < 0.9 || c.lastFinalOk === false) return "DEGRADED";
  return "OK";
}

export async function readAiHealth(db: Db, windowHours = 24): Promise<AiHealth & { lastThreeFailed: boolean }> {
  const calls = await db.query<{ calls: number; ok: number; retry_ok: number; last_at: Date | null; last_err_at: Date | null }>(
    `SELECT count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok, count(*) FILTER (WHERE ok AND attempt > 1)::int AS retry_ok,
            max(at) AS last_at, max(at) FILTER (WHERE NOT ok) AS last_err_at
       FROM ai_attempts WHERE final AND at > now() - make_interval(hours => $1)`, [windowHours]);
  const last = await db.query<{ ok: boolean; reason: string | null; at: Date }>(
    `SELECT ok, reason, at FROM ai_attempts WHERE final ORDER BY at DESC LIMIT 3`);
  const lastErr = await db.query<{ reason: string | null; at: Date }>(
    `SELECT reason, at FROM ai_attempts WHERE NOT ok ORDER BY at DESC LIMIT 1`);
  const models = await db.query<{ provider: string; model: string; attempts: number; ok: number; avg_ms: number | null; p90_ms: number | null; last_ok: Date | null; last_err: Date | null; last_reason: string | null }>(
    `SELECT provider, model, count(*)::int AS attempts, count(*) FILTER (WHERE ok)::int AS ok,
            round(avg(latency_ms) FILTER (WHERE ok))::int AS avg_ms,
            (percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok))::int AS p90_ms,
            max(at) FILTER (WHERE ok) AS last_ok, max(at) FILTER (WHERE NOT ok) AS last_err,
            (array_agg(reason ORDER BY at DESC) FILTER (WHERE NOT ok))[1] AS last_reason
       FROM ai_attempts WHERE at > now() - make_interval(hours => $1)
      GROUP BY provider, model ORDER BY count(*) DESC`, [windowHours]);
  const c = calls.rows[0]!;
  const recent = last.rows;
  return {
    windowHours,
    calls: {
      calls: c.calls, ok: c.ok, answeredByRetry: c.retry_ok, lastCallAt: c.last_at,
      lastFinalOk: recent[0] ? recent[0].ok : null,
      lastErrorAt: lastErr.rows[0]?.at ?? null, lastErrorReason: lastErr.rows[0]?.reason ?? null,
    },
    models: models.rows.map((r) => ({
      provider: r.provider, model: r.model, attempts: r.attempts, ok: r.ok, avgLatencyMs: r.avg_ms, p90LatencyMs: r.p90_ms,
      lastOkAt: r.last_ok, lastErrorAt: r.last_err, lastErrorReason: r.last_reason,
    })),
    lastThreeFailed: recent.length === 3 && recent.every((r) => !r.ok),
  };
}
