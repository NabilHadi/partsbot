import type { z } from "zod";
import { OneEpcError } from "./errors.js";
import {
  decodeResponseSchema,
  errorEnvelopeSchema,
  searchResponseSchema,
  statusResponseSchema,
  type DecodeResponse,
  type StatusResponse,
  type Lang,
  type SearchResponse,
} from "./types.js";

export interface OneEpcClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Total attempts for 5xx / network errors (default 3 = 1 try + 2 retries). */
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** Upper bound on how long we honor Retry-After (default 30s). */
  maxRetryAfterMs?: number;
}

/** Every successful call returns the data plus the headers we want in logs. */
export interface OneEpcResult<T> {
  data: T;
  requestId: string | null;
  dataVersion: string | null;
}

export interface SearchPartsParams {
  q?: string;
  lang?: Lang;
  category?: string;
  limit?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OneEpcClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetryAfterMs: number;

  constructor(opts: OneEpcClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000;
  }

  /** GET /status: liveness + auth check (needs a valid key; 401 invalid_key otherwise). No retries beyond the usual. */
  getStatus(): Promise<OneEpcResult<StatusResponse>> {
    return this.get("/status", {}, statusResponseSchema);
  }

  /** Decode a VIN. `match` is exact | ambiguous | none; 404/422/400 throw OneEpcError. */
  decode(vin: string): Promise<OneEpcResult<DecodeResponse>> {
    return this.get("/vehicles/decode", { vin: vin.trim() }, decodeResponseSchema);
  }

  /** Search parts for a vehicle_id (opaque; pass back exactly what decode returned). */
  searchParts(vehicleId: string, params: SearchPartsParams = {}): Promise<OneEpcResult<SearchResponse>> {
    return this.get(
      `/vehicles/${encodeURIComponent(vehicleId)}/parts/search`,
      { q: params.q, lang: params.lang, category: params.category, limit: params.limit },
      searchResponseSchema,
    );
  }

  private async get<S extends z.ZodType>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: S,
  ): Promise<OneEpcResult<z.output<S>>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    let retried429 = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let failure: OneEpcError | undefined;
      try {
        res = await this.fetchFn(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        failure = new OneEpcError(0, "network_error", `OneEPC request failed: ${(err as Error).message}`);
      }

      if (res?.ok) {
        const requestId = res.headers.get("x-request-id");
        const dataVersion = res.headers.get("x-data-version");
        const parsed = schema.safeParse(await res.json().catch(() => undefined));
        if (!parsed.success) {
          throw new OneEpcError(res.status, "invalid_response", `Unexpected OneEPC response shape: ${parsed.error.message}`, requestId);
        }
        return { data: parsed.data, requestId, dataVersion };
      }

      if (res) failure = await this.toError(res);
      const err = failure!;

      // 429: exactly one retry, after Retry-After.
      if (err.status === 429 && !retried429) {
        retried429 = true;
        const waitMs = Math.min((err.retryAfterSeconds ?? 1) * 1000, this.maxRetryAfterMs);
        await this.sleep(waitMs);
        continue;
      }
      // 5xx / network: exponential backoff up to maxAttempts.
      if ((err.status >= 500 || err.status === 0) && attempt < this.maxAttempts) {
        await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }

  /** Parse the spec's error envelope; fall back to a generic code for non-JSON bodies (e.g. proxy 502 pages). */
  private async toError(res: Response): Promise<OneEpcError> {
    const retryAfter = Number(res.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(retryAfter) && res.headers.has("retry-after") ? retryAfter : null;
    const headerRequestId = res.headers.get("x-request-id");
    const body = errorEnvelopeSchema.safeParse(await res.json().catch(() => undefined));
    if (body.success) {
      const { code, message, request_id } = body.data.error;
      return new OneEpcError(res.status, code, message, request_id ?? headerRequestId, retryAfterSeconds);
    }
    return new OneEpcError(res.status, "unexpected_response", `OneEPC returned HTTP ${res.status} without an error envelope`, headerRequestId, retryAfterSeconds);
  }
}
