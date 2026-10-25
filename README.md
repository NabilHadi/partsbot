# PartsBot

WhatsApp parts-lookup assistant for auto-parts shops. Backend: Node 20, TypeScript (strict, ESM),
Fastify 5, Postgres (`pg`) + pg-boss for jobs, zod for config and API validation, vitest for tests.
Catalog data comes from the read-only **OneEPC Bot API v1** (spec in the MVP Technical Plan).

Status: skeleton. Done: config, app factory + `/health`, DB migration runner and initial schema,
typed OneEPC client (`decode`, `searchParts`), a mock OneEPC server, the Zernio WhatsApp webhook receiver
(signature check, dedupe, enqueue) and a Zernio send wrapper, tests. Not built yet: any automatic reply, the
pg-boss message pipeline (worker only logs job ids), LLM/STT, inventory, part detail/diagram/status endpoints.

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
src/config.ts            zod-validated env (PORT, DATABASE_URL, ONEEPC_*, ZERNIO_*)
src/server.ts            Fastify app factory + GET /health (db check only if a pool is injected); mounts the Zernio webhook if given deps
src/queues.ts            pg-boss queue names
src/queue/inbound.ts     enqueues to the `inbound-message` queue (singletonKey, short retention)
src/routes/              zernio-webhook.ts (POST /webhooks/zernio)
src/zernio/              signature.ts, types.ts (zod), dedupe.ts (Postgres), send.ts (SDK wrapper with retries)
src/scripts/             sign-test-payload.ts (prints a signed curl for local testing)
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

## Zernio WhatsApp webhook

Research notes with doc URLs and unverified points: [`docs/zernio-notes.md`](docs/zernio-notes.md).

- `POST /webhooks/zernio` verifies `X-Zernio-Signature` (hex HMAC-SHA256 of the raw body with `ZERNIO_WEBHOOK_SECRET`), then
  enqueues `message.received` events on the pg-boss `inbound-message` queue and answers 200. It never replies to anyone.
  Duplicate deliveries (Zernio retries up to 7 times over ~51h) are dropped via the `inbound_dedupe` table keyed on the WhatsApp message id.
  Bad signature: 401. Signed but malformed: 400. Enqueue failure: 500 (so Zernio retries). Unknown events: 200, ignored.
- The route is only mounted when `ZERNIO_WEBHOOK_SECRET` is set, and `main.ts` then needs a database (pg-boss).
  Run `npm run migrate` first (adds `inbound_dedupe`).
- `src/zernio/send.ts`: `ZernioSender.sendText({conversationId, accountId}, body, {idempotencyKey})`, retries 429 only by default.
  Nothing calls it yet and no test hits the network.

### Register the webhook (Zernio dashboard or API)

1. Generate a secret: `openssl rand -hex 32`, put it in `.env` as `ZERNIO_WEBHOOK_SECRET`.
2. In Zernio create a webhook with URL `https://<your-host>/webhooks/zernio`, the **same secret**,
   and events `message.received` (plus `message.delivered`, `message.read`, `message.failed` if wanted). Webhooks are team-wide;
   optionally filter by account id, and set `ZERNIO_ACCOUNT_ID` so other accounts' events are ignored.
3. Trigger a test delivery (Zernio sends `webhook.test`; exact dashboard control unverified) (answered 200, ignored, not retried).

### Test locally

```bash
export ZERNIO_WEBHOOK_SECRET=$(openssl rand -hex 32)      # same value for server and script
npm run migrate && npm run dev                              # needs DATABASE_URL, Postgres
# in another shell: prints a signed curl with FAKE data (kinds: received | delivered | test)
npx tsx src/scripts/sign-test-payload.ts received | bash
# repeat the same command with --id/--wamid fixed to see "duplicate":
npx tsx src/scripts/sign-test-payload.ts received --id e1 --wamid w1 | bash
```

To reach a local server from Zernio use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`) and register that URL.

PDPL: job payloads in `pg_boss` contain the customer's text and phone, so jobs are kept 3 days after completion; logs carry ids only.

## Mock data

All VINs (`TEST...`), vehicle ids (`veh_example_*`) and part numbers (`00000-EXAMPLEn`) are fake by design.
Try: `TESTLC20220000001` (Land Cruiser, exact), `TESTHY20210000002` (Hyundai Tucson), `TESTKA20230000006` (Kia),
`TESTAMB2020000003` (ambiguous), `TESTNF00000000004` (not found), `TESTBMW2020000005` (unsupported brand).

## Privacy (PDPL)

Customer phone numbers are stored as a keyed hash plus an encrypted copy; rows carry `retention_until`;
`consent_records` keeps consent evidence. The schema only provides the columns: hashing, encryption and the purge job are still to be written.
