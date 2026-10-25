import { z } from "zod";

/**
 * Zod schemas for the Zernio webhook payloads we act on. Shapes come from the official docs and the
 * @zernio/node generated types (WebhookPayloadMessage, WebhookPayloadMessageDeliveryStatus), see
 * docs/zernio-notes.md. Unknown fields are stripped (zod default) so we never keep what we don't need.
 * Required fields are limited to what the pipeline depends on, so a harmless upstream addition or a
 * missing optional field does not break the receiver.
 */

/** Every event: only `id` and `event` are needed to route it. */
export const envelopeSchema = z.object({
  id: z.string().min(1),
  event: z.string().min(1),
  test: z.boolean().optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

const accountSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1).optional(),
  platform: z.string().optional(),
});

const conversationSchema = z.object({
  id: z.string().min(1),
  platformConversationId: z.string().optional(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  platform: z.string().min(1),
  /** The provider (WhatsApp) message id, "wamid...". Our idempotency key. */
  platformMessageId: z.string().min(1),
  direction: z.enum(["incoming", "outgoing"]),
  text: z.string().nullable().optional().transform((v) => v ?? null),
  attachments: z
    .array(z.object({ type: z.string(), url: z.string().optional() }))
    .optional()
    .transform((v) => v ?? []),
  sender: z.object({
    /** WhatsApp: phone number without "+" when available, else the BSUID. */
    id: z.string().min(1),
    /** E.164 with "+", omitted for users who hide their number (BSUID rollout). */
    phoneNumber: z.string().nullable().optional(),
    businessScopedUserId: z.string().optional(),
    name: z.string().optional(),
  }),
  sentAt: z.string().optional(),
});

export const messageReceivedSchema = envelopeSchema.extend({
  event: z.literal("message.received"),
  message: messageSchema,
  conversation: conversationSchema,
  account: accountSchema,
  metadata: z
    .object({
      /** true when another app (e.g. Meta Business Agent) owns the conversation. */
      standby: z.boolean().optional(),
      interactiveType: z.string().optional(),
      interactiveId: z.string().optional(),
    })
    .optional(),
});
export type MessageReceived = z.infer<typeof messageReceivedSchema>;

export const STATUS_EVENTS = ["message.delivered", "message.read", "message.played", "message.failed"] as const;

export const messageStatusSchema = envelopeSchema.extend({
  event: z.enum(STATUS_EVENTS),
  message: messageSchema,
  statusAt: z.string().optional(),
  error: z
    .object({ code: z.number().optional(), title: z.string().optional() })
    .nullable()
    .optional(),
  conversation: conversationSchema,
  account: accountSchema,
});
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** What the receiver puts on the pg-boss `inbound-message` queue. Contains personal data (PDPL): never log it. */
export interface InboundMessageJob {
  source: "zernio";
  /** Zernio event id (payload.id == X-Zernio-Event-Id). */
  eventId: string;
  /** Provider (WhatsApp) message id; the dedupe key. */
  providerMessageId: string;
  zernioMessageId: string;
  /** Needed to reply: POST /v1/inbox/conversations/{conversationId}/messages with accountId. */
  conversationId: string;
  accountId: string;
  senderId: string;
  senderPhone: string | null;
  senderBsuid: string | null;
  text: string | null;
  attachments: Array<{ type: string; url?: string }>;
  sentAt: string | null;
  /** Another app owns the conversation: the pipeline must not reply (replying takes control back). */
  standby: boolean;
  isTest: boolean;
  receivedAt: string;
}

export function toInboundJob(ev: MessageReceived, now: Date = new Date()): InboundMessageJob {
  return {
    source: "zernio",
    eventId: ev.id,
    providerMessageId: ev.message.platformMessageId,
    zernioMessageId: ev.message.id,
    conversationId: ev.conversation.id,
    accountId: ev.account.accountId ?? ev.account.id,
    senderId: ev.message.sender.id,
    senderPhone: ev.message.sender.phoneNumber ?? null,
    senderBsuid: ev.message.sender.businessScopedUserId ?? null,
    text: ev.message.text,
    attachments: ev.message.attachments,
    sentAt: ev.message.sentAt ?? null,
    standby: ev.metadata?.standby === true,
    isTest: ev.test === true,
    receivedAt: now.toISOString(),
  };
}
