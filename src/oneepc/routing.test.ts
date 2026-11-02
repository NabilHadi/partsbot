import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { FAKE_VINS } from "../mock/fixtures.js";
import { BASE_PATH, buildMockServer } from "../mock/oneepc-mock.js";
import { OneEpcClient } from "./client.js";
import { OneEpcError } from "./errors.js";
import { oneEpcRoutingFromConfig } from "./from-config.js";
import { checkOneEpc, OneEpcRouting } from "./routing.js";

const KEY = "mock-key";
let mock: FastifyInstance;
let mockUrl: string;

beforeAll(async () => {
  mock = buildMockServer({ apiKey: KEY });
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}${BASE_PATH}`;
});
afterAll(() => mock.close());

const mockClient = () => new OneEpcClient({ baseUrl: mockUrl, apiKey: KEY, maxAttempts: 1 });
/** A "real" client that must never be called in mock-routed tests. */
const throwingReal = () =>
  new OneEpcClient({ baseUrl: "http://real.invalid/api/bot/v1", apiKey: "k", fetch: (async () => { throw new Error("real API must not be called"); }) as typeof fetch, maxAttempts: 1 });

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => undefined, (e: unknown) => e);
}

describe("getStatus", () => {
  it("parses the live /status shape (mock mirrors it)", async () => {
    const { data, requestId } = await mockClient().getStatus();
    expect(data.ok).toBe(true);
    expect(data.api_version).toBe("1.0");
    expect(data.brands).toContain("toyota");
    expect(requestId).toMatch(/^req_/);
  });

  it("checkOneEpc: ok / auth_failed / unreachable / not_configured", async () => {
    expect((await checkOneEpc(mockClient())).state).toBe("ok");
    const bad = new OneEpcClient({ baseUrl: mockUrl, apiKey: "wrong", maxAttempts: 1 });
    expect(await checkOneEpc(bad)).toMatchObject({ state: "auth_failed", detail: "HTTP 401 invalid_key" });
    const down = new OneEpcClient({ baseUrl: "http://127.0.0.1:9/api/bot/v1", apiKey: "k", maxAttempts: 1, timeoutMs: 500 });
    expect((await checkOneEpc(down)).state).toBe("unreachable");
    expect((await checkOneEpc(null)).state).toBe("not_configured");
  });

  it("checkOneEpc never puts the key in its detail", async () => {
    const secret = "oeb_SECRET_should_not_leak";
    const c = new OneEpcClient({ baseUrl: mockUrl, apiKey: secret, maxAttempts: 1 });
    expect(JSON.stringify(await checkOneEpc(c))).not.toContain(secret);
  });
});

describe("OneEpcRouting", () => {
  const mocked = () => new OneEpcRouting({ real: throwingReal(), mock: mockClient(), sources: { decode: "mock", search: "mock" } });

  it("serves mock decode/search to a test shop", async () => {
    const r = await mocked().forShop({ testShop: true }).decode(FAKE_VINS.exactLandCruiser);
    expect(r.data.match).toBe("exact");
  });

  it("never serves mock data to a real shop: catalog_unavailable, real API untouched", async () => {
    const c = mocked().forShop({ testShop: false });
    for (const p of [c.decode(FAKE_VINS.exactLandCruiser), c.searchParts("veh_example_lc", { q: "brake pads" })]) {
      const err = await caught(p);
      expect(err).toBeInstanceOf(OneEpcError);
      expect(err).toMatchObject({ status: 503, code: "catalog_unavailable" });
    }
  });

  it("real source goes to the real client for every shop (test shops included)", async () => {
    const r = new OneEpcRouting({ real: mockClient(), mock: null, sources: { decode: "real", search: "real" } });
    expect((await r.forShop({ testShop: false }).decode(FAKE_VINS.exactLandCruiser)).data.match).toBe("exact");
    expect((await r.forShop({ testShop: true }).decode(FAKE_VINS.exactLandCruiser)).data.match).toBe("exact");
  });

  it("real source without a key is unavailable, not a silent mock fallback", async () => {
    const r = new OneEpcRouting({ real: null, mock: mockClient(), sources: { decode: "real", search: "real" } });
    expect(await caught(r.forShop({ testShop: true }).decode(FAKE_VINS.exactLandCruiser))).toMatchObject({ code: "catalog_unavailable" });
  });

  it("from config: mock sources need ONEEPC_MOCK_BASE_URL; decode/search must match", () => {
    const base = { DATABASE_URL: "postgres://x" };
    expect(() => loadConfig({ ...base, ONEEPC_DECODE_SOURCE: "mock", ONEEPC_SEARCH_SOURCE: "mock" })).toThrow(/ONEEPC_MOCK_BASE_URL/);
    expect(() => loadConfig({ ...base, ONEEPC_DECODE_SOURCE: "real", ONEEPC_SEARCH_SOURCE: "mock", ONEEPC_MOCK_BASE_URL: mockUrl })).toThrow(/ONEEPC_SEARCH_SOURCE/);
    const cfg = loadConfig({ ...base, ONEEPC_API_KEY: "k", ONEEPC_DECODE_SOURCE: "mock", ONEEPC_SEARCH_SOURCE: "mock", ONEEPC_MOCK_BASE_URL: mockUrl, ONEEPC_MOCK_API_KEY: KEY });
    const r = oneEpcRoutingFromConfig(cfg);
    expect(r.sources).toEqual({ decode: "mock", search: "mock" });
    expect(r.real).not.toBeNull();
    expect(r.mock).not.toBeNull();
    expect(oneEpcRoutingFromConfig(loadConfig(base)).real).toBeNull();
  });
});
