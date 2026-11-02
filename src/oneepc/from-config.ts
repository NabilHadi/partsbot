import type { Config } from "../config.js";
import { OneEpcClient } from "./client.js";
import { OneEpcRouting } from "./routing.js";

/** Real + mock clients and the per-endpoint sources, from validated env. Keys never leave the clients. */
export function oneEpcRoutingFromConfig(config: Config): OneEpcRouting {
  const real = config.ONEEPC_API_KEY ? new OneEpcClient({ baseUrl: config.ONEEPC_BASE_URL, apiKey: config.ONEEPC_API_KEY }) : null;
  const mock = config.ONEEPC_MOCK_BASE_URL
    ? new OneEpcClient({ baseUrl: config.ONEEPC_MOCK_BASE_URL, apiKey: config.ONEEPC_MOCK_API_KEY ?? "mock-dev-key", maxAttempts: 1 })
    : null;
  return new OneEpcRouting({ real, mock, sources: { decode: config.ONEEPC_DECODE_SOURCE, search: config.ONEEPC_SEARCH_SOURCE } });
}
