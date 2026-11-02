/**
 * Offline eval of the AI layer against the REAL model (costs a few cents). Run: npm run eval-ai
 *   Same AI settings as the app (never printed): AI_PROVIDER=gemini|deepseek, AI_FALLBACK_PROVIDER, GEMINI_MODEL / GEMINI_FALLBACK_MODEL,
 *   DEEPSEEK_MODEL / DEEPSEEK_FALLBACK_MODEL / DEEPSEEK_THINKING, AI_TIMEOUT_MS, and the provider's API key.
 *   Cost is printed at the peak price and, for providers with an off-peak discount (DeepSeek), off-peak too.
 *   EVAL_ONLY=slang,typos to run some categories, EVAL_IDS=pipe-02 for single cases, EVAL_CONCURRENCY (default 4), EVAL_DELAY_MS (pause between calls),
 *   EVAL_OUT=path.json for the raw results.
 * Understand cases call stage 1 directly; "pipeline" cases run the whole engine (AI + synonyms + mock OneEPC + compose)
 * and check the reply carries the right catalogue numbers and no others.
 * Prints scores only: no customer data is involved (the fixtures are synthetic).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiFromConfig, engineAi } from "../ai/index.js";
import { costUsd, type AiProvider, type AiUsage } from "../ai/provider.js";
import { loadConfig } from "../config.js";
import { SYNONYM_SEED } from "../ai/synonym-seed.js";
import { SynonymIndex } from "../ai/synonyms.js";
import { understandMessage, type HistoryTurn, type Understanding } from "../ai/understand.js";
import { Conversation } from "../bot/conversation-driver.js";
import { findPartNumberLikeTokens } from "../bot/guard.js";
import { recording, startMock } from "../bot/testkit.js";

interface ExpPart { g: string; pos?: string; qty?: number }
interface Case {
  id: string; cat: string; text: string;
  ctx?: { vehicle?: string; lastPart?: string; waitingFor?: string; history?: [string, string][] };
  intent?: string[]; vin?: string; parts?: ExpPart[]; noNumbers?: boolean;
  pipeline?: boolean; expectNumbers?: string[];
}
interface Outcome { id: string; cat: string; pass: boolean; why: string[]; latencyMs: number; costUsd: number; costOffPeakUsd: number; calls: number; model: string; fallbackUsed?: boolean }

/** A Sunday noon UTC: off-peak for every provider that has off-peak prices. */
const OFF_PEAK = new Date("2026-11-01T12:00:00Z");
const cost2 = (model: string, u: AiUsage) => ({ peak: costUsd(model, u) ?? 0, off: costUsd(model, u, OFF_PEAK) ?? 0 });

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "../ai/eval/fixtures.json"), "utf8")) as { groups: Record<string, string[]>; cases: Case[] };
const norm = (s: string) => s.toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function scoreUnderstanding(c: Case, u: Understanding): string[] {
  const why: string[] = [];
  if (c.intent && !c.intent.includes(u.intent)) why.push(`intent ${u.intent} (want ${c.intent.join("|")})`);
  if (c.vin !== undefined && compact(u.vin_or_frame ?? "") !== compact(c.vin)) why.push(`vin ${u.vin_or_frame ?? "null"} (want ${c.vin})`);
  if (c.vin === undefined && c.cat !== "vin_part" && u.vin_or_frame) why.push(`vin invented: ${u.vin_or_frame}`);
  if (c.parts) {
    const left = [...u.parts];
    for (const e of c.parts) {
      const keys = (fx.groups[e.g] ?? [e.g]).map(norm);
      const i = left.findIndex((p) => keys.some((k) => norm(`${p.normalized_en} | ${p.normalized_ar} | ${p.customer_words}`).includes(k)) && (!e.pos || p.position === e.pos));
      if (i < 0) {
        why.push(`missing ${e.g}${e.pos ? `/${e.pos}` : ""} (got ${u.parts.map((p) => `${p.normalized_en}/${p.position ?? "-"}`).join(", ") || "none"})`);
        continue;
      }
      if (e.qty && left[i]!.qty !== e.qty) why.push(`qty ${left[i]!.qty} (want ${e.qty})`);
      left.splice(i, 1);
    }
    if (left.length) why.push(`extra parts: ${left.map((p) => p.normalized_en).join(", ")}`);
  }
  if (c.noNumbers) {
    const out = u.parts.flatMap((p) => [p.normalized_en, p.normalized_ar]).flatMap(findPartNumberLikeTokens);
    if (out.length) why.push(`number in normalized name: ${out.join(",")}`);
  }
  return why;
}

async function runUnderstand(provider: AiProvider, c: Case): Promise<Outcome> {
  const history: HistoryTurn[] = (c.ctx?.history ?? []).map(([from, text]) => ({ from: from === "bot" ? "bot" : "customer", text }));
  const r = await understandMessage(provider, {
    text: c.text, history, vehicle: c.ctx?.vehicle ?? null, language: "auto", waitingFor: c.ctx?.waitingFor ?? null, lastPart: c.ctx?.lastPart ?? null,
  });
  const cost = cost2(r.model, r.usage);
  const base = { id: c.id, cat: c.cat, latencyMs: r.latencyMs, costUsd: cost.peak, costOffPeakUsd: cost.off, calls: 1, model: r.model, fallbackUsed: r.model !== provider.model };
  if (!r.ok) {
    // Refusing to invent a number is the right outcome for an injection that asks for one.
    const fine = r.reason === "invented_part_number" && c.noNumbers;
    return { ...base, pass: !!fine, why: fine ? [] : [`ai failed: ${r.reason}`] };
  }
  const why = scoreUnderstanding(c, r.data);
  return { ...base, pass: why.length === 0, why };
}

async function runPipeline(provider: AiProvider, c: Case, mockClient: Awaited<ReturnType<typeof startMock>>["client"], synonyms: SynonymIndex): Promise<Outcome & { composeOk: boolean | null; validator: string | null }> {
  const rec = recording(mockClient);
  const conv = new Conversation(rec, { aiEnabled: true });
  conv.extras = { ai: engineAi(provider), synonyms };
  const r = await conv.say(c.text);
  const reply = r.replies.join("\n");
  const why: string[] = [];
  for (const pn of c.expectNumbers ?? []) if (!reply.includes(pn)) why.push(`missing ${pn}`);
  for (const tok of findPartNumberLikeTokens(reply)) if (!rec.partNumbers.has(tok)) why.push(`INVENTED ${tok}`);
  if (r.replies.length > 1) why.push(`${r.replies.length} messages (want 1)`);
  const calls = conv.allActions.flatMap((a) => (a.type === "ai_call" ? [a] : []));
  for (const a of calls) if (!a.ok && a.stage === "understand") why.push(`understand failed: ${a.reason}`);
  const compose = calls.find((a) => a.stage === "compose");
  const latencyMs = calls.reduce((s, a) => s + a.latencyMs, 0);
  const costs = calls.map((a) => cost2(a.model, { inputTokens: a.inputTokens, outputTokens: a.outputTokens, cachedInputTokens: a.cachedInputTokens ?? 0 }));
  const cost = costs.reduce((s, x) => s + x.peak, 0);
  const costOff = costs.reduce((s, x) => s + x.off, 0);
  return {
    id: c.id, cat: c.cat, pass: why.length === 0, why, latencyMs, costUsd: cost, costOffPeakUsd: costOff, calls: calls.length, model: calls[0]?.model ?? provider.model,
    fallbackUsed: calls.some((a) => a.model !== provider.model),
    composeOk: compose ? compose.ok : null, validator: compose ? (compose.validator ?? compose.reason ?? null) : null,
    // Fixture text + mock catalogue only (no customer data): kept so failures can be read in EVAL_OUT.
    ...(why.length ? { reply, oneEpcCalls: rec.calls } : {}),
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
      if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }));
  return out;
}

/** Pause between calls per worker, to stay under the key's requests-per-minute quota (EVAL_DELAY_MS). */
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 0);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

async function main(): Promise<void> {
  const config = loadConfig({ DATABASE_URL: "postgres://unused/eval", ...process.env, AI_ENABLED: "true" });
  const setup = createAiFromConfig(config);
  if (!setup.enabled) {
    console.error(`eval-ai: AI not available (${setup.reason}). Set the API key for AI_PROVIDER=${config.AI_PROVIDER}.`);
    process.exit(2);
  }
  const provider = setup.provider;
  const check = await provider.check();
  console.log(`provider ${provider.name}, model ${provider.model}${provider.fallbackModel ? ` (retry on ${provider.fallbackProvider ?? provider.name} ${provider.fallbackModel})` : ""}: ${check.ok ? "OK" : "FAILED"} ${check.detail}`);
  if (!check.ok) process.exit(2);

  const only = process.env.EVAL_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = process.env.EVAL_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const cases = fx.cases.filter((c) => (!only || only.includes(c.cat)) && (!ids || ids.includes(c.id)));
  const mock = await startMock();
  const synonyms = new SynonymIndex(SYNONYM_SEED.map(([term, canonicalAr, canonicalEn]) => ({ term, canonicalAr, canonicalEn })));
  const started = Date.now();
  try {
    const results = await pool(cases, Number(process.env.EVAL_CONCURRENCY ?? 4), (c) =>
      (c.pipeline ? runPipeline(provider, c, mock.client, synonyms) : runUnderstand(provider, c)).catch(
        (err: unknown): Outcome => ({ id: c.id, cat: c.cat, pass: false, why: [`crash: ${(err as Error)?.name}`], latencyMs: 0, costUsd: 0, costOffPeakUsd: 0, calls: 0, model: provider.model }),
      ),
    );

    const cats = [...new Set(results.map((r) => r.cat))];
    console.log(`\n${"category".padEnd(16)} pass   total  acc   avg ms`);
    for (const cat of cats) {
      const rs = results.filter((r) => r.cat === cat);
      const ok = rs.filter((r) => r.pass).length;
      const ms = Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length);
      console.log(`${cat.padEnd(16)} ${String(ok).padStart(4)}  ${String(rs.length).padStart(5)}  ${pct(ok, rs.length).padStart(4)}  ${String(ms).padStart(6)}`);
    }
    const ok = results.filter((r) => r.pass).length;
    console.log(`${"ALL".padEnd(16)} ${String(ok).padStart(4)}  ${String(results.length).padStart(5)}  ${pct(ok, results.length).padStart(4)}`);

    const und = results.filter((r) => !("composeOk" in r));
    const pipe = results.filter((r) => "composeOk" in r) as Array<Outcome & { composeOk: boolean | null; validator: string | null }>;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const sorted = und.map((r) => r.latencyMs).sort((a, b) => a - b);
    const offTxt = (rs: Outcome[]) => (rs.some((r) => r.costOffPeakUsd !== r.costUsd) ? ` (off-peak $${avg(rs.map((r) => r.costOffPeakUsd)).toFixed(6)})` : "");
    console.log(`\nunderstand call: avg ${Math.round(avg(sorted))} ms, p50 ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)] ?? 0} ms, max ${sorted.at(-1) ?? 0} ms; avg cost $${avg(und.map((r) => r.costUsd)).toFixed(6)}${offTxt(und)}`);
    if (pipe.length) {
      const ps = pipe.map((r) => r.latencyMs).sort((a, b) => a - b);
      console.log(`full message (understand + compose): avg ${Math.round(avg(ps))} ms, p50 ${ps[Math.floor(ps.length / 2)] ?? 0} ms, p90 ${ps[Math.floor(ps.length * 0.9)] ?? 0} ms, avg cost $${avg(pipe.map((r) => r.costUsd)).toFixed(6)}${offTxt(pipe)}, avg ${avg(pipe.map((r) => r.calls)).toFixed(1)} calls`);
      const composed = pipe.filter((r) => r.composeOk !== null);
      console.log(`compose: ${composed.filter((r) => r.composeOk).length}/${composed.length} accepted by the validator; rejections: ${composed.filter((r) => !r.composeOk).map((r) => r.validator).join(", ") || "none"}`);
    }
    const fb = results.filter((r) => r.fallbackUsed).length;
    if (fb) console.log(`fallback model answered ${fb} case(s)`);
    const all = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    console.log(`all cases: p50 ${all[Math.floor(all.length / 2)] ?? 0} ms, p90 ${all[Math.floor(all.length * 0.9)] ?? 0} ms`);
    console.log(`total cost $${results.reduce((s, r) => s + r.costUsd, 0).toFixed(4)} at peak price (off-peak $${results.reduce((s, r) => s + r.costOffPeakUsd, 0).toFixed(4)}), wall ${Math.round((Date.now() - started) / 1000)} s`);

    const fails = results.filter((r) => !r.pass);
    if (fails.length) {
      console.log(`\nfailures (${fails.length}):`);
      for (const f of fails) {
        const c = cases.find((x) => x.id === f.id)!;
        console.log(`  ${f.id.padEnd(12)} ${JSON.stringify(c.text).slice(0, 70)}\n               ${f.why.join("; ")}`);
      }
    }
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify(results, null, 2));
  } finally {
    await mock.close();
  }
}

main().catch((err: unknown) => {
  console.error(`eval-ai crashed: ${(err as Error)?.name}: ${(err as Error)?.message?.slice(0, 200)}`);
  process.exit(1);
});
