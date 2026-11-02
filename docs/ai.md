# AI layer (`src/ai`)

The AI helps the bot understand customer messages and word its replies. **It never chooses or invents part numbers.** Part numbers come only from OneEPC results, and the code decides what to send.

## Pipeline (per inbound message, `src/bot/engine.ts`)

1. **Rules parse** (`src/bot/arabic.ts`): VIN, yes/no, part words, greetings.
2. **Synonyms**: a deterministic layer (`synonyms` table, migration 006). It rewrites the customer's words to the canonical part name (for example `قماشات` to `فحمات فرامل`). The AI never edits this list.
3. **AI understand** (`understand.ts`): returns zod-checked JSON with the intent, the parts (with position/side), the vehicle hints and the language. The call is skipped when the rules are enough (a bare VIN, a short yes/no, a variant pick). If it fails or is invalid, the rules result is used.
   Words the AI mapped that the synonym list doesn't know become **pending suggestions** (`synonym_suggestions`). They are never applied automatically; an admin approves or rejects them at `/admin/synonyms`.
4. **OneEPC decode + search**: this is the only source of part numbers.
5. **Code decides** what to show (stock, prices, show-part-numbers settings). When there are several candidates, the AI may only **pick an index** or **ask a question** (`select.ts`). Anything else is ignored.
6. **AI compose** (`compose.ts`): writes one longer reply from the facts the code passes in. `validate.ts` rejects the draft if it:
   - adds a part number, number, price or URL that isn't in the facts;
   - drops a placeholder or the "confirm with staff" line;
   - is in the wrong language;
   - goes off-topic;
   - is too long or empty.

   If the draft is rejected, the template reply is sent instead.
7. History: the last 6 turns, 300 characters each. It is kept only for AI shops and sent to understand.

Scope: shop customer service only (parts, stock, prices, VIN, staff handoff). Off-topic messages get a short polite redirect. This is needed because of Meta's WhatsApp policy on general-purpose assistants. Per-shop message caps still apply, and the AI makes no calls once the cap is reached.

## Switches

- **Server**: `AI_ENABLED=true` and the API key of the default provider (`GEMINI_API_KEY` / `DEEPSEEK_API_KEY` in `logs/secrets.env`, mode 600, never printed). If either is missing, every shop runs on rules plus templates.
- **Shop**: `aiEnabled` in the shop config (admin settings or `npm run shop -- set <id> aiEnabled=true`).
  - Default: off.
  - `shop create --test` turns it on for test shops.
- **Provider per shop**: `aiProvider` = `server_default` (default) | `gemini` | `deepseek`. A provider without a key on the server falls back to the default (alert `ai_provider_unavailable`).

### Providers and models

Both sit behind `AiProvider` (`provider.ts`). A `ChainProvider` makes at most two attempts: the main model, then ONE retry (on timeout, rate limit, overload, empty or bad JSON; also on quota/auth/HTTP errors when the retry goes to another model or provider). Same zod schemas, validators and timeout for every provider.

| Env var | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `gemini` | Server default provider |
| `AI_FALLBACK_PROVIDER` | (unset) | When set and different from the provider in use, the retry goes to that provider's main model (e.g. DeepSeek first, Gemini Flash-Lite on retry) |
| `AI_TIMEOUT_MS` | 25000 | Per attempt |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | `gemini-3.8-flash`, none | Legacy names `AI_MODEL` / `AI_FALLBACK_MODEL` still work |
| `DEEPSEEK_MODEL`, `DEEPSEEK_FALLBACK_MODEL` | `deepseek-flash`, none | `deepseek-flash` = DeepSeek-V4.1-Flash (V4-Flash is retired; `deepseek-v4-flash` is a legacy alias of the same model) |
| `DEEPSEEK_THINKING` | `disabled` | `low` / `high` = thinking mode (slower, costs output tokens) |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible |

- **Gemini** (`gemini.ts`): REST `generateContent` with a response JSON schema. A 429 with a per-day quota id is reported as `quota` (not retried on the same model).
- **DeepSeek** (`deepseek.ts`): `POST /chat/completions` with `response_format: json_object`; the JSON schema is appended to the system prompt and the answer is validated with the same zod schema. Errors: 402 = `quota` (no balance), 429 = `rate_limited`, 500/503 = `overloaded`, 401/403 = `auth`. `check()` = `GET /models`.
- **Prices** (`PRICES_PER_M`, for the cost estimate): Gemini from https://ai.google.dev/gemini-api/docs/pricing; DeepSeek from https://api-docs.deepseek.com/quick_start/pricing (deepseek-flash peak: input $0.30 per 1M on a cache miss, $0.006 on a cache hit, output $1.20; off-peak half. Peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri = 04:00–07:00 and 09:00–13:00 Riyadh).

### Health on /admin/app

Every model attempt is stored in `ai_attempts` (provider, model, stage, attempt, ok, reason code, latency, token counts; **no text**; kept 30 days). `/admin/app` shows, for the last 24 h: calls answered / total, how many were answered by the retry, the last error (e.g. `quota`, `timeout`) with its time, and per model the success rate and latency. State: OK (≥ 90 % and the last call answered), DEGRADED, FAILING (< 50 % or the last 3 calls failed), or no calls. The key check (Gemini `models.get` / DeepSeek `GET /models`) is shown separately; it only says the key and model are accepted, not that calls succeed.

## Logging

`ai_call` events record:
- stage, ok/reason, model, latency, input/output/cached tokens, estimated cost, intent, part count, validator outcome.

`synonym_suggestions` events carry only a count. Prompts, customer text and replies are never logged.

## Eval

`npm run eval-ai` runs `src/ai/eval/fixtures.json` against the real model: about 100 Gulf Arabic, arabizi and English cases in 12 categories. Pipeline cases go through the full conversation with the mock OneEPC.

| Env var | Purpose |
| --- | --- |
| `EVAL_ONLY=cat1,cat2` | Run only these categories |
| `EVAL_IDS=id1,id2` | Run only these cases |
| `EVAL_CONCURRENCY` | Default 4 |
| `EVAL_DELAY_MS` | Pause between calls (free-tier RPM) |
| `EVAL_OUT=file.json` | Write the raw results to a file |

The provider and models come from the same env vars as the app (e.g. `AI_PROVIDER=deepseek npm run eval-ai`). Cost is printed at the peak price and, for DeepSeek, off-peak too.

Results (2026-11-02, saved in `/workspace/partsbot-data/eval-ai-*.txt`): deepseek-flash 102/104, understand p50 1.2 s / p90 1.4 s; gemini-3.1-flash-lite 100/104 with the old timeout (103/104 after re-running the 3 slang timeouts with 25 s).

Unit tests mock the model (`src/ai/testkit.ts`).

**Free tier note**: the free tier of Gemini 3.8 Flash allows **20 generate requests per day per model**. One eval run, or a few customers, uses that up. Production needs a billed key.
