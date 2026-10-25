# PartsBot

WhatsApp parts-lookup assistant for auto-parts shops. Backend: Node 20, TypeScript (strict, ESM),
Fastify 5, Postgres (`pg`) + pg-boss for jobs, zod for config and API validation, vitest for tests.
Catalog data comes from the read-only **OneEPC Bot API v1** (spec in the MVP Technical Plan).

Status: skeleton. Done: config, app factory + `/health`, DB migration runner and initial schema,
typed OneEPC client (`decode`, `searchParts`), a mock OneEPC server, tests. Not built yet: webhooks,
the pg-boss message pipeline (worker only logs jobs), LLM/STT, inventory, part detail/diagram/status endpoints.

## Setup

```bash
npm install
cp .env.example .env     # edit DATABASE_URL; defaults point at the local mock
```

## Run

```bash
npm run mock        # fake OneEPC API on http://127.0.0.1:4010/api/bot/v1  (Bearer mock-dev-key)
npm run migrate     # apply src/db/migrations/*.sql to DATABASE_URL (needs Postgres 13+)
npm run dev         # API with auto-reload, GET /health
npm run worker      # (after npm run build) pg-boss worker process, separate from the API
npm run build && npm start   # production build of the API
npm test            # vitest (starts the mock on a random port; no database needed)
npm run typecheck
```

The `.env` file is not auto-loaded; use `node --env-file=.env ...` or export the variables
(e.g. `set -a; . ./.env; set +a`).

## Layout

```
src/config.ts            zod-validated env (PORT, DATABASE_URL, ONEEPC_BASE_URL, ONEEPC_API_KEY)
src/server.ts            Fastify app factory + GET /health (db check only if a pool is injected)
src/main.ts              API entry point
src/worker.ts            pg-boss worker entry point (placeholder queue handler)
src/db/                  pool.ts, migrate.ts (simple runner), migrations/001_init.sql
src/oneepc/              types.ts (zod), errors.ts (OneEpcError), client.ts (fetch, retries)
src/mock/                oneepc-mock.ts (Fastify mock), fixtures.ts (FAKE data)
```

## OneEPC client notes

- `Authorization: Bearer <key>`; errors are parsed from the spec's `{ error: { code, message, request_id } }`
  envelope into `OneEpcError` (`status`, `code`, `requestId`). Branch on `code`.
- One retry on 429 after `Retry-After`; retry with exponential backoff (3 attempts) on 5xx and network errors; never on other 4xx.
- Successful calls return `{ data, requestId, dataVersion }` so each answer can log which catalog release produced it.
- Response schemas strip unknown fields; a response that fails validation throws `OneEpcError` with code `invalid_response`.

## Mock data

All VINs (`TEST...`), vehicle ids (`veh_example_*`) and part numbers (`00000-EXAMPLEn`) are fake by design.
Try: `TESTLC20220000001` (Land Cruiser, exact), `TESTHY20210000002` (Hyundai Tucson), `TESTKA20230000006` (Kia),
`TESTAMB2020000003` (ambiguous), `TESTNF00000000004` (not found), `TESTBMW2020000005` (unsupported brand).

## Privacy (PDPL)

Customer phone numbers are stored as a keyed hash plus an encrypted copy; rows carry `retention_until`;
`consent_records` keeps consent evidence. The schema only provides the columns: hashing, encryption and the purge job are still to be written.
