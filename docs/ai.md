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

- **Server**: `AI_ENABLED=true` and `GEMINI_API_KEY` (in `logs/secrets.env`, mode 600, never printed). If either is missing, every shop runs on rules plus templates.
- **Shop**: `aiEnabled` in the shop config (admin settings or `npm run shop -- set <id> aiEnabled=true`).
  - Default: off.
  - `shop create --test` turns it on for test shops.
- `AI_MODEL` (default `gemini-3.8-flash`), `AI_FALLBACK_MODEL` (used for the one retry), `AI_TIMEOUT_MS` (default 25000 per attempt).
- The provider sits behind `AiProvider` (`provider.ts`); today Gemini REST (`gemini.ts`) is the only implementation.
- `/admin/app` shows AI on/off, the model, the fallback model and a `models.get` key check. That check does **not** consume or detect the daily generate quota.

## Logging

`ai_call` events record:
- stage, ok/reason, model, latency, input/output tokens, intent, part count, validator outcome.

`synonym_suggestions` events carry only a count. Prompts, customer text and replies are never logged.

## Eval

`npm run eval-ai` runs `src/ai/eval/fixtures.json` against the real model: about 100 Gulf Arabic, arabizi and English cases in 12 categories. Pipeline cases go through the full conversation with the mock OneEPC.

| Env var | Purpose |
| --- | --- |
| `EVAL_ONLY=cat1,cat2` | Run only these categories |
| `EVAL_CONCURRENCY` | Default 4 |
| `EVAL_DELAY_MS` | Pause between calls (free-tier RPM) |
| `EVAL_OUT=file.json` | Write the raw results to a file |

Unit tests mock the model (`src/ai/testkit.ts`).

**Free tier note**: the free tier of Gemini 3.8 Flash allows **20 generate requests per day per model**. One eval run, or a few customers, uses that up. Production needs a billed key.
