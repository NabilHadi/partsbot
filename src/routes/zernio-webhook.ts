import type { FastifyPluginAsync } from "fastify";
import type { InboundQueue } from "../queue/inbound.js";
import type { DedupeStore } from "../zernio/dedupe.js";
import { SIGNATURE_HEADERS, verifySignature } from "../zernio/signature.js";
import {
  envelopeSchema,
  messageReceivedSchema,
  messageStatusSchema,
  STATUS_EVENTS,
  toInboundJob,
} from "../zernio/types.js";

export interface ZernioWebhookDeps {
  /** The secret we registered on the Zernio webhook endpoint (ZERNIO_WEBHOOK_SECRET). */
  secret: string;
  /** If set, events for any other Zernio account are acknowledged and ignored. */
  accountId?: string;
  dedupe: DedupeStore;
  queue: InboundQueue;
  path?: string;
  now?: () => Date;
}

const MAX_BODY_BYTES = 1_048_576;

/**
 * POST /webhooks/zernio. Registered as an encapsulated plugin so the raw-body JSON parser applies to
 * this route only; the rest of the app keeps Fastify's normal parser.
 *
 * Status codes (Zernio retries any non-2xx up to 7 times over ~51h, and needs a 2xx within 5s):
 *   401 missing/invalid signature, 400 signed but malformed, 500 enqueue failed (retry wanted),
 *   200 everything else, including ignored events and duplicates.
 * Responses never echo request content. Logs carry ids only, never message text or phone numbers.
 */
export const zernioWebhookRoutes = (deps: ZernioWebhookDeps): FastifyPluginAsync =>
  async (app) => {
    const now = deps.now ?? (() => new Date());

    // Keep the exact bytes: the HMAC is over the raw body, not over re-serialized JSON.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => {
      done(null, body);
    });

    app.post(deps.path ?? "/webhooks/zernio", async (req, reply) => {
      const raw = req.body as Buffer;

      let signature: string | undefined;
      for (const h of SIGNATURE_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") {
          signature = v;
          break;
        }
      }
      if (!verifySignature(raw, signature, deps.secret)) {
        req.log.warn("zernio webhook: signature check failed");
        return reply.code(401).send({ error: "unauthorized" });
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        req.log.warn("zernio webhook: signed body is not JSON");
        return reply.code(400).send({ error: "invalid_payload" });
      }

      const envelope = envelopeSchema.safeParse(json);
      if (!envelope.success) {
        req.log.warn("zernio webhook: payload has no id/event");
        return reply.code(400).send({ error: "invalid_payload" });
      }
      const { id: eventId, event } = envelope.data;
      const log = req.log.child({ zernioEventId: eventId, zernioEvent: event });

      if (event === "message.received") {
        const parsed = messageReceivedSchema.safeParse(json);
        if (!parsed.success) {
          // paths only, never values
          log.warn({ issues: parsed.error.issues.map((i) => i.path.join(".")) }, "zernio webhook: invalid message.received");
          return reply.code(400).send({ error: "invalid_payload" });
        }
        const ev = parsed.data;
        const accountId = ev.account.accountId ?? ev.account.id;
        if (deps.accountId && accountId !== deps.accountId) {
          log.info({ accountId }, "zernio webhook: other account, ignored");
          return { status: "ignored" };
        }
        if (ev.message.platform !== "whatsapp" || ev.message.direction !== "incoming") {
          log.info({ platform: ev.message.platform, direction: ev.message.direction }, "zernio webhook: not an inbound WhatsApp message, ignored");
          return { status: "ignored" };
        }

        const key = `zernio:${ev.message.platformMessageId}`;
        if (!(await deps.dedupe.claim(key, eventId))) {
          log.info({ providerMessageId: ev.message.platformMessageId }, "zernio webhook: duplicate delivery, skipped");
          return { status: "duplicate" };
        }
        try {
          await deps.queue.enqueue(toInboundJob(ev, now()), key);
        } catch (err) {
          // Let Zernio's retry through: drop the claim and answer 5xx.
          await deps.dedupe.release(key).catch(() => undefined);
          log.error({ errMessage: (err as Error).message }, "zernio webhook: enqueue failed");
          return reply.code(500).send({ error: "enqueue_failed" });
        }
        log.info(
          { providerMessageId: ev.message.platformMessageId, conversationId: ev.conversation.id, standby: ev.metadata?.standby === true },
          "zernio webhook: inbound message enqueued",
        );
        return { status: "queued" };
      }

      if ((STATUS_EVENTS as readonly string[]).includes(event)) {
        const parsed = messageStatusSchema.safeParse(json);
        if (!parsed.success) {
          log.warn({ issues: parsed.error.issues.map((i) => i.path.join(".")) }, "zernio webhook: invalid status event");
          return reply.code(400).send({ error: "invalid_payload" });
        }
        // Delivery tracking is not built yet: record the outcome (ids and error code only) and acknowledge.
        log.info(
          { providerMessageId: parsed.data.message.platformMessageId, errorCode: parsed.data.error?.code },
          "zernio webhook: message status",
        );
        return { status: "recorded" };
      }

      log.info("zernio webhook: event type not handled, ignored");
      return { status: "ignored" };
    });
  };
