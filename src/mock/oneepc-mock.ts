// Mock OneEPC Bot API v1 for local development and tests. Fake data only (see fixtures.ts).
// Run: `npm run mock` (default port 4010, base path /api/bot/v1).
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  BROAD_QUERY_AMBIGUITY,
  BROAD_TERMS,
  DATA_VERSION,
  KNOWN_VEHICLE_IDS,
  NOT_AMBIGUOUS,
  PARTS,
  SUPPORTED_BRANDS,
  VIN_FIXTURES,
} from "./fixtures.js";
// TEST FIXTURE: fake Camry with real Medrar numbers, to exercise the stock lookup (see stock-test-fixtures.ts).
import { STOCK_TEST_PARTS, STOCK_TEST_VIN, stockTestCamry } from "./stock-test-fixtures.js";

const ALL_PARTS = [...PARTS, ...STOCK_TEST_PARTS];
const ALL_VEHICLE_IDS: ReadonlySet<string> = new Set([...KNOWN_VEHICLE_IDS, stockTestCamry.vehicle_id]);
const ALL_VINS: typeof VIN_FIXTURES = { ...VIN_FIXTURES, [STOCK_TEST_VIN]: { kind: "exact", vehicle: stockTestCamry } };
import type { PartResult, SearchAmbiguity } from "../oneepc/types.js";

export const BASE_PATH = "/api/bot/v1";

export interface MockOptions {
  apiKey?: string;
  logger?: boolean;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({
    error: { code, message, request_id: String(reply.getHeader("x-request-id")) },
  });
}

/** Lowercase, strip Arabic diacritics/tatweel, unify alef/ya/ta-marbuta variants. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

function detectLang(q: string): "ar" | "en" | "mixed" {
  const ar = /[\u0600-\u06FF]/.test(q);
  const en = /[a-z]/i.test(q);
  return ar && en ? "mixed" : ar ? "ar" : "en";
}

export function buildMockServer(opts: MockOptions = {}): FastifyInstance {
  const apiKey = opts.apiKey ?? "mock-dev-key";
  const app = Fastify({ logger: opts.logger ?? false });

  app.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        reply.header("X-Request-Id", `req_${randomBytes(6).toString("hex")}`);
        reply.header("X-Data-Version", DATA_VERSION);
        reply.header("X-RateLimit-Remaining", "59");
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          return sendError(reply, 401, "invalid_key", "Missing or invalid API key");
        }
      });

      // 0. Status (same shape as the live oneepc.com /status)
      api.get("/status", async () => ({
        ok: true,
        api_version: "1.0",
        data_version: DATA_VERSION,
        brands: ["toyota", "hyundai", "kia", "daihatsu"],
        markets: { toyota: ["GR", "US", "EU", "JP"], hyundai: ["MES"], kia: ["MES"], daihatsu: ["09", "10", "11"] },
      }));

      // 1. Decode a VIN
      api.get<{ Querystring: { vin?: string } }>("/vehicles/decode", async (req, reply) => {
        const vin = (req.query.vin ?? "").replace(/\s+/g, "").toUpperCase();
        if (vin.length !== 17 || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
          return sendError(reply, 400, "invalid_vin", "VIN must be 17 characters (letters and digits, no I, O or Q)");
        }
        const fx = ALL_VINS[vin];
        if (!fx) return sendError(reply, 404, "vin_not_found", "No vehicle found for this VIN");
        if (fx.kind === "unsupported") {
          return sendError(
            reply,
            422,
            "unsupported_brand",
            `Brand not supported. Supported: ${SUPPORTED_BRANDS.join(", ")}`,
          );
        }
        if (fx.kind === "ambiguous") {
          return { match: "ambiguous", vehicle: null, candidates: fx.candidates };
        }
        return { match: "exact", vehicle: { ...fx.vehicle, vin }, candidates: [] };
      });

      // 2. Search parts for a vehicle
      api.get<{
        Params: { vehicle_id: string };
        Querystring: { q?: string; q_en?: string; lang?: string; category?: string; limit?: string };
      }>("/vehicles/:vehicle_id/parts/search", async (req, reply) => {
        const { vehicle_id } = req.params;
        const { lang = "auto", category } = req.query;
        const q = (req.query.q ?? "").trim();
        const qEn = (req.query.q_en ?? "").trim();

        if (!q && !category) return sendError(reply, 400, "missing_query", "Provide q or category");
        if (!["ar", "en", "auto"].includes(lang)) {
          return sendError(reply, 400, "invalid_param", "lang must be ar, en or auto");
        }
        const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
          return sendError(reply, 400, "invalid_param", "limit must be an integer between 1 and 20");
        }
        if (!ALL_VEHICLE_IDS.has(vehicle_id)) {
          return sendError(reply, 404, "vehicle_not_found", "Unknown or expired vehicle_id");
        }

        // Drop the Arabic definite article so "الفرامل" matches "فرامل".
        const toTokens = (text: string) =>
          normalizeText(text)
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => (t.length > 3 ? t.replace(/^ال/, "") : t));
        // q and the optional q_en are scored separately; the better score counts.
        const queries = [toTokens(q), toTokens(qEn)].filter((t) => t.length > 0);
        const scored = ALL_PARTS.flatMap((p) => {
          const fitment = p.fitment[vehicle_id];
          if (!fitment) return [];
          if (category && p.category.id !== category) return [];
          let score = 1;
          if (queries.length) {
            const haystack = normalizeText([p.name.ar ?? "", p.name.en ?? "", ...p.keywords].join(" "));
            score = Math.max(...queries.map((tokens) => Math.round((tokens.filter((t) => haystack.includes(t)).length / tokens.length) * 100) / 100));
            if (score < 0.5) return []; // text match too weak
          }
          return [{ part: p, fitment, score }];
        });
        scored.sort((a, b) => b.score - a.score || a.part.part_number.localeCompare(b.part.part_number));
        const top = scored.slice(0, limit);

        const results: PartResult[] = top.map(({ part, fitment, score }) => ({
          part_number: part.part_number,
          name: part.name,
          category: part.category,
          diagram_id: part.diagram_id,
          callout: part.callout,
          quantity_per_vehicle: part.quantity_per_vehicle,
          fitment,
          score,
        }));

        let ambiguity: SearchAmbiguity = NOT_AMBIGUOUS;
        const conditional = top.find((t) => t.fitment.status === "conditional" && t.part.ambiguity);
        if (conditional?.part.ambiguity) ambiguity = conditional.part.ambiguity;
        else if (results.length > 1 && BROAD_TERMS.has(normalizeText(q))) ambiguity = BROAD_QUERY_AMBIGUITY;

        return {
          vehicle_id,
          query: { q, lang_detected: lang === "auto" ? detectLang(q) : lang },
          ambiguity,
          results,
        };
      });
    },
    { prefix: BASE_PATH },
  );

  app.setNotFoundHandler((_req, reply) => {
    reply.header("X-Request-Id", `req_${randomBytes(6).toString("hex")}`);
    return sendError(reply, 404, "not_found", "No such endpoint (the mock implements decode and parts/search only)");
  });

  return app;
}

// CLI: `npm run mock`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  const apiKey = process.env.MOCK_API_KEY ?? "mock-dev-key";
  const app = buildMockServer({ apiKey, logger: true });
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`Mock OneEPC at http://127.0.0.1:${port}${BASE_PATH} (Bearer ${apiKey})`);
}
