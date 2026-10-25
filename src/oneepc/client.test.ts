import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_VINS } from "../mock/fixtures.js";
import { BASE_PATH, buildMockServer } from "../mock/oneepc-mock.js";
import { OneEpcClient } from "./client.js";
import { OneEpcError } from "./errors.js";

const API_KEY = "test-key";
let mock: FastifyInstance;
let client: OneEpcClient;
let baseUrl: string;

beforeAll(async () => {
  mock = buildMockServer({ apiKey: API_KEY });
  await mock.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}${BASE_PATH}`;
  client = new OneEpcClient({ baseUrl, apiKey: API_KEY });
});
afterAll(() => mock.close());

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OneEpcError);
  expect(err).toMatchObject({ status, code });
  expect((err as OneEpcError).requestId).toMatch(/^req_/);
}

describe("decode", () => {
  it("exact match (Land Cruiser) with headers surfaced", async () => {
    const { data, requestId, dataVersion } = await client.decode(FAKE_VINS.exactLandCruiser);
    expect(data.match).toBe("exact");
    expect(data.vehicle).toMatchObject({
      vehicle_id: "veh_example_lc",
      brand: "toyota",
      model: { ar: "لاند كروزر", en: "Land Cruiser" },
      year: 2022,
    });
    expect(data.candidates).toEqual([]);
    expect(requestId).toMatch(/^req_/);
    expect(dataVersion).toBeTruthy();
  });

  it("exact match (Hyundai), uppercasing and trimming the VIN", async () => {
    const { data } = await client.decode(`  ${FAKE_VINS.exactHyundai.toLowerCase()}  `);
    expect(data.vehicle?.make).toBe("Hyundai");
    expect(data.vehicle?.vin).toBe(FAKE_VINS.exactHyundai);
  });

  it("ambiguous VIN returns null vehicle and candidates that differ by engine", async () => {
    const { data } = await client.decode(FAKE_VINS.ambiguous);
    expect(data.match).toBe("ambiguous");
    expect(data.vehicle).toBeNull();
    expect(data.candidates).toHaveLength(2);
    expect(data.candidates.map((c) => c.differs_by)).toEqual(["engine", "engine"]);
    expect(new Set(data.candidates.map((c) => c.vehicle_id)).size).toBe(2);
  });

  it("400 invalid_vin for wrong length", async () => {
    await expectError(client.decode("SHORT"), 400, "invalid_vin");
  });

  it("404 vin_not_found for an unknown VIN", async () => {
    await expectError(client.decode(FAKE_VINS.unknown), 404, "vin_not_found");
  });

  it("422 unsupported_brand", async () => {
    await expectError(client.decode(FAKE_VINS.unsupportedBrand), 422, "unsupported_brand");
  });
});

describe("searchParts", () => {
  it("Arabic query: front brake pads with conditional fitment and an ambiguity object", async () => {
    const { data } = await client.searchParts("veh_example_lc", { q: "فحمات قدام", lang: "auto" });
    expect(data.query.lang_detected).toBe("ar");
    expect(data.results[0]).toMatchObject({
      part_number: "00000-EXAMPLE1",
      name: { ar: "فحمات فرامل أمامية", en: "Pad kit, disc brake, front" },
      fitment: { status: "conditional", conditions: ["17 inch brakes"] },
    });
    expect(data.ambiguity).toMatchObject({
      is_ambiguous: true,
      reason: "multiple_variants",
      differs_by: "brake_size",
    });
    expect(data.ambiguity.question_hint?.ar).toBeTruthy();
  });

  it("English query: oil filter confirmed, no ambiguity", async () => {
    const { data } = await client.searchParts("veh_example_tucson", { q: "oil filter", lang: "en" });
    expect(data.results[0]).toMatchObject({ part_number: "00000-EXAMPLE5", fitment: { status: "confirmed" } });
    expect(data.ambiguity.is_ambiguous).toBe(false);
  });

  it("Arabic oil filter and mixed-language queries", async () => {
    const ar = await client.searchParts("veh_example_lc", { q: "فلتر زيت" });
    expect(ar.data.results[0]?.part_number).toBe("00000-EXAMPLE4");
    const mixed = await client.searchParts("veh_example_lc", { q: "فحمات front" });
    expect(mixed.data.query.lang_detected).toBe("mixed");
    expect(mixed.data.results[0]?.part_number).toBe("00000-EXAMPLE1");
  });

  it("part with no Arabic name keeps ar null", async () => {
    const { data } = await client.searchParts("veh_example_lc", { q: "air filter" });
    expect(data.results[0]?.name).toEqual({ ar: null, en: "Filter, air cleaner" });
  });

  it("broad query is flagged ambiguous; limit is honored", async () => {
    const { data } = await client.searchParts("veh_example_lc", { q: "brakes", limit: 1 });
    expect(data.results).toHaveLength(1);
    const broad = await client.searchParts("veh_example_lc", { q: "brakes" });
    expect(broad.data.results.length).toBeGreaterThan(1);
  });

  it("200 with empty results when nothing matches", async () => {
    const { data } = await client.searchParts("veh_example_lc", { q: "xyzzy flux capacitor" });
    expect(data.results).toEqual([]);
  });

  it("category-only search works", async () => {
    const { data } = await client.searchParts("veh_example_lc", { category: "engine" });
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.every((r) => r.category.id === "engine")).toBe(true);
  });

  it("400 missing_query", async () => {
    await expectError(client.searchParts("veh_example_lc", {}), 400, "missing_query");
  });

  it("400 invalid_param for limit > 20", async () => {
    await expectError(client.searchParts("veh_example_lc", { q: "oil", limit: 50 }), 400, "invalid_param");
  });

  it("404 vehicle_not_found", async () => {
    await expectError(client.searchParts("veh_nope", { q: "oil filter" }), 404, "vehicle_not_found");
  });
});

describe("auth", () => {
  it("401 invalid_key with a wrong key", async () => {
    const bad = new OneEpcClient({ baseUrl, apiKey: "wrong" });
    await expectError(bad.decode(FAKE_VINS.exactLandCruiser), 401, "invalid_key");
    await expectError(bad.searchParts("veh_example_lc", { q: "oil" }), 401, "invalid_key");
  });
});

describe("retry behaviour (stubbed fetch)", () => {
  const okBody = { match: "none", vehicle: null, candidates: [] };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const rateLimited = () =>
    json(429, { error: { code: "rate_limited", message: "slow down", request_id: "req_x" } }, { "Retry-After": "2" });
  const unavailable = () => json(503, { error: { code: "unavailable", message: "down", request_id: "req_y" } });

  function stubbed(responses: Array<() => Response | Error>) {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchStub = (async () => {
      const next = responses[Math.min(calls++, responses.length - 1)]!();
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
    const c = new OneEpcClient({
      baseUrl: "http://x/api/bot/v1",
      apiKey: "k",
      fetch: fetchStub,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { c, sleeps, calls: () => calls };
  }

  it("retries once on 429 honoring Retry-After", async () => {
    const s = stubbed([rateLimited, () => json(200, okBody)]);
    await expect(s.c.decode("TESTLC20220000001")).resolves.toBeTruthy();
    expect(s.sleeps).toEqual([2000]);
    expect(s.calls()).toBe(2);
  });

  it("gives up after a second 429", async () => {
    const s = stubbed([rateLimited]);
    await expectError2(s.c.decode("TESTLC20220000001"), 429, "rate_limited");
    expect(s.calls()).toBe(2);
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    const s = stubbed([unavailable, unavailable, () => json(200, okBody)]);
    await expect(s.c.decode("TESTLC20220000001")).resolves.toBeTruthy();
    expect(s.sleeps).toEqual([250, 500]);
  });

  it("surfaces the last 5xx after exhausting attempts", async () => {
    const s = stubbed([unavailable]);
    await expectError2(s.c.decode("TESTLC20220000001"), 503, "unavailable");
    expect(s.calls()).toBe(3);
  });

  it("retries network errors, and does not retry 4xx", async () => {
    const net = stubbed([() => new Error("ECONNRESET"), () => json(200, okBody)]);
    await expect(net.c.decode("TESTLC20220000001")).resolves.toBeTruthy();
    const bad = stubbed([() => json(404, { error: { code: "vin_not_found", message: "no", request_id: "r" } })]);
    await expectError2(bad.c.decode("TESTLC20220000001"), 404, "vin_not_found");
    expect(bad.calls()).toBe(1);
  });

  it("maps a non-envelope error body and an invalid success body", async () => {
    const html = stubbed([() => new Response("<html>bad gateway</html>", { status: 400 })]);
    await expectError2(html.c.decode("TESTLC20220000001"), 400, "unexpected_response");
    const weird = stubbed([() => json(200, { nope: true })]);
    await expectError2(weird.c.decode("TESTLC20220000001"), 200, "invalid_response");
  });

  async function expectError2(p: Promise<unknown>, status: number, code: string) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OneEpcError);
    expect(err).toMatchObject({ status, code });
  }
});
