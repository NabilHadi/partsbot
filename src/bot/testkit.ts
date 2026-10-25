// Test helpers: real OneEpcClient against the in-process mock, plus failing fakes. Tests only.
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildMockServer, BASE_PATH } from "../mock/oneepc-mock.js";
import { OneEpcClient, OneEpcError } from "../oneepc/index.js";
import type { OneEpcLike } from "./engine.js";

export async function startMock(): Promise<{ client: OneEpcClient; close: () => Promise<void> }> {
  const mock: FastifyInstance = buildMockServer({ apiKey: "test-key" });
  await mock.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}${BASE_PATH}`;
  const client = new OneEpcClient({ baseUrl, apiKey: "test-key", sleep: async () => {}, backoffBaseMs: 0 });
  return { client, close: () => mock.close() };
}

/** Wraps a client and records every part number it returned (the only numbers a reply may contain). */
export function recording(inner: OneEpcLike): OneEpcLike & { partNumbers: Set<string>; calls: string[] } {
  const partNumbers = new Set<string>();
  const calls: string[] = [];
  return {
    partNumbers,
    calls,
    async decode(vin) {
      calls.push("decode");
      return inner.decode(vin);
    },
    async searchParts(id, p) {
      calls.push("search");
      const r = await inner.searchParts(id, p);
      r.data.results.forEach((x) => partNumbers.add(x.part_number));
      return r;
    },
  };
}

/** A OneEPC that fails every call with the given envelope code. */
export function failing(status: number, code: string): OneEpcLike {
  const fail = async () => {
    throw new OneEpcError(status, code, "boom: SECRET-UPSTREAM-TEXT", "req_failing");
  };
  return { decode: fail, searchParts: fail };
}

/** A OneEPC that answers decode via `inner` but fails search. */
export function searchFailing(inner: OneEpcLike, status: number, code: string): OneEpcLike {
  return {
    decode: (v) => inner.decode(v),
    searchParts: async () => {
      throw new OneEpcError(status, code, "boom: SECRET-UPSTREAM-TEXT", "req_failing");
    },
  };
}

export const countMessages = (c: { turns: { from: string }[] }) => c.turns.filter((t) => t.from === "bot").length;
