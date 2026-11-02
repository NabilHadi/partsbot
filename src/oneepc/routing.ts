/**
 * Per-endpoint routing between the real OneEPC Bot API (oneepc.com) and the local mock.
 *
 * Live on oneepc.com today (probed 2026-11-02): GET /status only. decode, parts/search, parts/{pn} and
 * diagrams/{id} answer 404 not_found. So each endpoint the bot uses has a source:
 *   ONEEPC_DECODE_SOURCE / ONEEPC_SEARCH_SOURCE = real | mock   (getStatus is always real)
 *
 * Rules (never invent part numbers):
 *   - "mock" is served ONLY to test shops (shops.config.testShop). A real shop on a mock endpoint gets a
 *     client that throws OneEpcError(503, "catalog_unavailable"), which the engine turns into a staff handoff
 *     plus a critical alert. It never sees mock data.
 *   - decode and search must use the SAME source: vehicle_id is opaque per backend, so a real decode followed
 *     by a mock search (or the reverse) would fail or, worse, mix catalogs. loadConfig refuses a split.
 */
import { OneEpcClient, type OneEpcResult, type SearchPartsParams } from "./client.js";
import { OneEpcError } from "./errors.js";
import type { DecodeResponse, SearchResponse, StatusResponse } from "./types.js";

export type OneEpcSource = "real" | "mock";
export type BotEndpoint = "decode" | "search";

/** What the bot engine needs (same as engine.OneEpcLike; repeated here to avoid an import cycle). */
export interface CatalogClient {
  decode(vin: string): Promise<OneEpcResult<DecodeResponse>>;
  searchParts(vehicleId: string, params?: SearchPartsParams): Promise<OneEpcResult<SearchResponse>>;
}

export interface OneEpcRoutingOptions {
  real: OneEpcClient | null; // null when ONEEPC_API_KEY is not set
  mock: OneEpcClient | null; // null when ONEEPC_MOCK_BASE_URL is not set
  sources: Record<BotEndpoint, OneEpcSource>;
}

export const CATALOG_UNAVAILABLE = "catalog_unavailable";

function unavailable(endpoint: BotEndpoint, why: string): Promise<never> {
  return Promise.reject(new OneEpcError(503, CATALOG_UNAVAILABLE, `OneEPC ${endpoint} is not available for this shop (${why})`));
}

export class OneEpcRouting {
  constructor(private readonly opts: OneEpcRoutingOptions) {}

  get sources(): Readonly<Record<BotEndpoint, OneEpcSource>> {
    return this.opts.sources;
  }

  /** The real client, for /status checks (null without a key). */
  get real(): OneEpcClient | null {
    return this.opts.real;
  }

  get mock(): OneEpcClient | null {
    return this.opts.mock;
  }

  /** Which client serves `endpoint` for a shop, or why none does. */
  resolve(endpoint: BotEndpoint, shop: { testShop: boolean }): { client: OneEpcClient } | { why: string } {
    const source = this.opts.sources[endpoint];
    if (source === "mock") {
      if (!shop.testShop) return { why: "mock-only endpoint; real shops never get mock data" };
      return this.opts.mock ? { client: this.opts.mock } : { why: "ONEEPC_MOCK_BASE_URL not set" };
    }
    return this.opts.real ? { client: this.opts.real } : { why: "ONEEPC_API_KEY not set" };
  }

  /** The catalog client the engine uses for one shop's turn. */
  forShop(shop: { testShop: boolean }): CatalogClient {
    const pick = (e: BotEndpoint) => this.resolve(e, shop);
    return {
      decode: (vin) => {
        const r = pick("decode");
        return "client" in r ? r.client.decode(vin) : unavailable("decode", r.why);
      },
      searchParts: (vehicleId, params) => {
        const r = pick("search");
        return "client" in r ? r.client.searchParts(vehicleId, params) : unavailable("search", r.why);
      },
    };
  }
}

export type OneEpcCheckState = "ok" | "auth_failed" | "not_configured" | "unreachable" | "error";

export interface OneEpcCheck {
  state: OneEpcCheckState;
  /** Human text for the admin page. Never contains the key. */
  detail: string;
  status?: StatusResponse;
}

/** GET /status with the client's key: tells reachable + authenticated apart from 401 and network failures. */
export async function checkOneEpc(client: OneEpcClient | null): Promise<OneEpcCheck> {
  if (!client) return { state: "not_configured", detail: "no API key configured" };
  try {
    const { data } = await client.getStatus();
    return {
      state: "ok",
      detail: `api ${data.api_version}, data version ${data.data_version.slice(0, 12)}, brands: ${data.brands.join(", ")}`,
      status: data,
    };
  } catch (err) {
    if (err instanceof OneEpcError) {
      if (err.status === 401 || err.code === "invalid_key") return { state: "auth_failed", detail: `HTTP ${err.status} ${err.code}` };
      if (err.status === 0) return { state: "unreachable", detail: err.message.replace(/^OneEPC request failed: /, "") };
      return { state: "error", detail: `HTTP ${err.status} ${err.code}${err.requestId ? ` (request ${err.requestId})` : ""}` };
    }
    return { state: "error", detail: (err as Error)?.name ?? "unknown error" };
  }
}
