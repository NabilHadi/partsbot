# Zernio notes (researched 2026-10-25)

Sources (official docs unless noted):
- Webhooks overview + signatures: https://docs.zernio.com/webhooks
- Inbox events (`message.received`, status events): https://docs.zernio.com/webhooks/inbox
- WhatsApp events: https://docs.zernio.com/webhooks/whatsapp
- Create/update webhook settings API: https://docs.zernio.com/webhooks/create-webhook-settings
- Send inbox message: https://docs.zernio.com/messages/send-inbox-message
- WhatsApp inbox / connection / sandbox: https://docs.zernio.com/platforms/whatsapp/inbox , `/connection` , `/sandbox`
- Multi-tenant inbox: https://docs.zernio.com/multi-tenant/inbox
- Idempotency feature request thread: https://requests.zernio.com/p/idempotency-key-on-inbox-message-sends
- SDK: https://www.npmjs.com/package/@zernio/node (pinned 0.2.1325; types/source read from the tarball)

## Webhook registration
Team-wide endpoint: URL + secret + list of events, optionally filtered by `profileIds` / `accountIds`. Created in the
dashboard or via the webhook settings API. The secret is chosen by us and sent back to us only as the HMAC key.

## Events we handle
- `message.received`: `{id, event, message{id, conversationId, platform, platformMessageId (wamid), direction, text, attachments[], sender{id, phoneNumber?, businessScopedUserId?, name}, sentAt}, conversation{id,...}, account{id, accountId, platform}, metadata?{standby, interactiveType, interactiveId}, timestamp}`.
  `sender.phoneNumber` can be absent (WhatsApp BSUID rollout, users hiding their number); `sender.id` is then the BSUID.
- `message.delivered|read|played|failed`: same plus `statusAt`, `error{code,title}`. Only logged (ids and error code).
- Everything else (templates, `message.sent`, `webhook.test`, future events): acknowledged with 200, ignored.
- `message.sent` with `source: "whatsapp_business_app"` appears on coexistence numbers (messages typed in the phone app).
- `metadata.standby: true` means another app owns the conversation; replying takes control back. Carried to the job as `standby`.

## Signature scheme
`X-Zernio-Signature` (legacy alias `X-Late-Signature`) = lowercase hex HMAC-SHA256 of the **raw request body** keyed by the webhook secret.
**No timestamp, no replay window** is documented. A "stale timestamp" check is therefore not implemented (and would
reject legitimate retries, which arrive up to ~51h later with the original event time). Replay protection = idempotent processing.
Companion headers: `X-Zernio-Event`, `X-Zernio-Event-Id` (= payload `id`).

## Delivery semantics
At-least-once. Non-2xx or no 2xx within **5 s** = retry, up to 7 attempts over ~51h. One event per request.
`webhook.test` is never retried. Dedupe on `payload.id`; we dedupe on the WhatsApp message id (`platformMessageId`), which also covers
a redelivery that carries a new event id.

## Sending
`POST /v1/inbox/conversations/{conversationId}/messages` body `{accountId, message}` plus `Idempotency-Key` header (SDK: `zernio.messages.sendInboxMessage`).
- Replies need `conversationId` + `accountId` (both in the inbound webhook), so `sendText` takes a target object, not a bare phone number.
- Free text only inside WhatsApp's 24h customer-service window; starting a chat needs an approved template (not implemented).
- Idempotency key: retained 24h. **A 5xx releases the key**, and the docs say a 5xx may still have been accepted by the platform,
  so retrying 5xx can double-send. Hence 5xx/network retry is opt-in (`retryOnServerError`, default off); 429 is always retried.
- Rate limits: HTTP 429 (`RateLimitError.getSecondsUntilReset()` in the SDK; no `Retry-After` exposed); WhatsApp per-recipient ~10 msgs/min returned as
  HTTP **400** code `131056` (treated as rate limit and retried); coexistence numbers capped at 20 msg/s.
- Errors: SDK exposes `ZernioApiError` (`statusCode`, `code`), `RateLimitError`, `ValidationError`.

## Test number / sandbox
Sandbox = shared Zernio number; the customer must first send the `sandbox_start` template reply to activate the session
(https://docs.zernio.com/platforms/whatsapp/sandbox). Coexistence lets the shop keep using the WhatsApp Business app on the same number.

## Not confirmed / assumed
- Exact dashboard UI for registering a webhook and the test-delivery control (docs describe the API; UI not checked).
- Whether the webhook secret has a format requirement. We require >= 16 chars (our own rule).
- Payload fields are taken from docs + generated SDK types, not from a live delivery. Only `id`, `event` and the fields listed as
  required in `types.ts` are enforced, everything else is tolerated. Verify with one real sandbox message.
- Whether header names are lower/upper-case variants other than those listed (Node lowercases them, so fine).
- Exact 429 body/headers (SDK does not expose `Retry-After`), so backoff is exponential unless `getSecondsUntilReset()` returns a value.
- Behaviour of `sendInboxMessage` return shape (`data.data.messageId`) is per SDK types; untested against the live API.
- pg-boss v10 `singletonKey` alone does not give durable dedupe on a standard queue; the Postgres `inbound_dedupe` table is the primary guard
  (claim before enqueue, release on enqueue failure). It was not run against a real Postgres in the test suite (fakes only);
  the SQL is a single `INSERT ... ON CONFLICT DO NOTHING`.
