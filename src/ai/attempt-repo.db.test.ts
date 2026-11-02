// ai_attempts against real Postgres (TEST_DATABASE_URL): record -> health numbers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, type Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { healthState, pruneAiAttempts, readAiHealth, recordAiAttempt } from "./attempt-repo.js";

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)("ai_attempts", () => {
  let db: Db;
  beforeAll(async () => {
    db = createPool(TEST_DB as string);
    await migrate(db);
    await db.query("DELETE FROM ai_attempts");
  });
  afterAll(async () => {
    if (db) {
      await db.query("DELETE FROM ai_attempts");
      await db.end();
    }
  });

  it("records attempts and reports call success, retries and the last error", async () => {
    const ev = (o: Partial<Parameters<typeof recordAiAttempt>[1]>) => ({
      callId: randomUUID(), final: true, provider: "deepseek", model: "deepseek-flash", stage: "understand", attempt: 1, ok: true, reason: null,
      latencyMs: 1000, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, ...o,
    });
    for (let i = 0; i < 3; i++) await recordAiAttempt(db, ev({}));
    const id = randomUUID();
    await recordAiAttempt(db, ev({ callId: id, final: false, ok: false, reason: "quota" }));
    await recordAiAttempt(db, ev({ callId: id, attempt: 2, provider: "gemini", model: "gemini-3.1-flash-lite", latencyMs: 900 }));
    await recordAiAttempt(db, ev({ ok: false, reason: "timeout", latencyMs: 25000 }));
    const h = await readAiHealth(db);
    expect(h.calls).toMatchObject({ calls: 5, ok: 4, answeredByRetry: 1, lastFinalOk: false, lastErrorReason: "timeout" });
    expect(healthState(h.calls, h.lastThreeFailed)).toBe("DEGRADED");
    const ds = h.models.find((m) => m.provider === "deepseek")!;
    expect(ds).toMatchObject({ attempts: 5, ok: 3, avgLatencyMs: 1000, lastErrorReason: "timeout" });
    expect(await pruneAiAttempts(db)).toBe(0);
  });
});
