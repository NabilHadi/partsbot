/**
 * Contract pairs from the OneEPC Bot API (NabilHadi/Hyundai PR #241, test/bot-contract/C1-C20.json, copied
 * into ./contract). Each recorded response is fed through the REAL client (stubbed fetch), so the zod schemas,
 * the error envelope and the header handling are all exercised. Placeholders become valid dummy values.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OneEpcClient } from "./client.js";
import { OneEpcError } from "./errors.js";

interface Pair {
  id: string;
  request: { method: string; path: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

const DUMMY: Record<string, string> = {
  "<VIN_LC>": "TESTLC20220000001", "<VIN_AMBIGUOUS>": "TESTAM20220000002", "<VIN_UNKNOWN>": "TESTUN20220000003", "<VIN_BMW>": "WBATEST0000000004",
  "<VEHICLE_ID>": "veh_dummy", "<DIAGRAM_ID>": "dg_dummy", "<REQUEST_ID>": "req_dummy", "<DATA_VERSION>": "ab12cd34", "<REMAINING>": "59",
};
const fill = (s: string) => s.replace(/<[A-Z0-9_]+>/g, (m) => DUMMY[m] ?? (m.startsWith("<PN_") ? `00000-${m.slice(4, -1)}` : m));

const dir = new URL("./contract/", import.meta.url);
const pairs: Pair[] = readdirSync(dir)
  .filter((f) => /^C\d+\.json$/.test(f))
  .map((f) => JSON.parse(fill(readFileSync(new URL(f, dir), "utf8"))) as Pair)
  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

function clientFor(p: Pair) {
  const seen: URL[] = [];
  const client = new OneEpcClient({
    baseUrl: "https://oneepc.invalid/api/bot/v1",
    apiKey: "k",
    maxAttempts: 1,
    sleep: async () => undefined,
    fetch: (async (u: string | URL) => {
      seen.push(new URL(String(u)));
      return new Response(JSON.stringify(p.response.body), { status: p.response.status, headers: { "content-type": "application/json", ...p.response.headers } });
    }) as typeof fetch,
  });
  return { client, seen };
}

/** Replay the recorded request through the matching client method. */
function call(p: Pair) {
  const { client, seen } = clientFor(p);
  const u = new URL(p.request.path, "https://x");
  const path = u.pathname.replace(/^\/api\/bot\/v1/, "");
  const q = Object.fromEntries(u.searchParams);
  let run: Promise<{ data: unknown; requestId: string | null; dataVersion: string | null }>;
  if (path === "/status") run = client.getStatus();
  else if (path === "/vehicles/decode") run = client.decode(q.vin ?? "");
  else {
    const m = /^\/vehicles\/([^/]+)\/parts\/search$/.exec(path);
    if (!m) throw new Error(`unmapped ${path}`);
    run = client.searchParts(decodeURIComponent(m[1]!), { q: q.q, q_en: q.q_en, lang: q.lang as "auto" | undefined, category: q.category, limit: q.limit ? Number(q.limit) : undefined });
  }
  return { run, seen };
}

describe("OneEPC Bot API contract files (Hyundai PR #241) parse with the real client", () => {
  it("has C1-C20", () => expect(pairs.map((p) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => `C${i + 1}`)));

  for (const p of pairs) {
    it(`${p.id}: HTTP ${p.response.status}`, async () => {
      const { run } = call(p);
      if (p.response.status < 400) {
        const r = await run;
        expect(r.requestId).toBe("req_dummy");
        expect(r.dataVersion).toBe("ab12cd34");
      } else {
        const err = await run.then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(OneEpcError);
        const body = p.response.body as { error: { code: string } };
        expect((err as OneEpcError).code).toBe(body.error.code);
        expect((err as OneEpcError).requestId).toBe("req_dummy");
      }
    });
  }

  const byId = Object.fromEntries(pairs.map((p) => [p.id, p]));
  const ok = async (id: string) => (await call(byId[id]!).run).data as any;
  const code = async (id: string) => ((await call(byId[id]!).run.catch((e: OneEpcError) => e)) as OneEpcError).code;

  it("outcomes PartsBot relies on", async () => {
    expect(await code("C2")).toBe("invalid_key");
    expect((await ok("C3")).match).toBe("exact");
    expect(await code("C4")).toBe("invalid_vin"); // frame numbers: VIN only
    const c5 = await ok("C5");
    expect(c5.match).toBe("ambiguous");
    expect(c5.vehicle).toBeNull();
    for (const c of c5.candidates) expect(typeof c.differs_by).toBe("string");
    expect(await code("C6")).toBe("invalid_vin");
    expect(await code("C7")).toBe("vin_not_found");
    expect(await code("C8")).toBe("unsupported_brand");
    const c9 = await ok("C9");
    expect(c9.results[0]).toMatchObject({ score: 1, fitment: { status: "confirmed" } });
    const c10 = await ok("C10"); // pipe-05
    expect(c10.ambiguity.is_ambiguous).toBe(false);
    expect(c10.results[0].score).toBeGreaterThanOrEqual(0.9);
    expect(c10.results[0].fitment.status).toBe("confirmed");
    const c11 = await ok("C11");
    expect(c11.ambiguity).toMatchObject({ is_ambiguous: true, differs_by: "position" });
    expect(c11.ambiguity.question_hint?.ar).toBeTruthy();
    const c12 = await ok("C12");
    expect(c12.ambiguity.is_ambiguous).toBe(false);
    expect(c12.results.every((r: any) => r.score >= 0.9)).toBe(true);
    expect((await ok("C14")).results).toEqual([]);
    expect((await ok("C15")).results).toEqual([]);
    expect(await code("C16")).toBe("missing_query");
    expect(await code("C17")).toBe("invalid_param");
    expect(await code("C18")).toBe("vehicle_not_found");
    const c19 = await ok("C19");
    expect(c19.ambiguity.is_ambiguous).toBe(true);
    expect(c19.results.some((r: any) => r.fitment.status === "conditional")).toBe(true);
    const c20 = await ok("C20"); // the swapped second call PartsBot makes
    expect(c20.results[0].score).toBeGreaterThanOrEqual(0.9);
    expect(c20.results[0].fitment.status).toBe("confirmed");
  });
});
