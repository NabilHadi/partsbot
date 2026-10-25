import { Zernio } from "@zernio/node";

/**
 * Sending a WhatsApp text through Zernio's inbox API:
 *   POST /v1/inbox/conversations/{conversationId}/messages  { accountId, message }  + Idempotency-Key header
 * (https://docs.zernio.com/messages/send-inbox-message). Replies go to an existing conversation, so the
 * target is the conversationId + accountId carried by the inbound webhook, not a bare phone number.
 * Free-form text only works inside WhatsApp's 24h customer-service window; opening a conversation
 * needs an approved template (POST /v1/inbox/conversations), which is not implemented here.
 */
export interface SendTarget {
  conversationId: string;
  accountId: string;
}

export interface SendOptions {
  /** Required. One UUID (or a stable id derived from the inbound message) per logical reply, max 255 chars. */
  idempotencyKey: string;
}

export interface SendResult {
  /** The raw WhatsApp message id (wamid), when Zernio returned one. */
  messageId?: string;
  attempts: number;
}

/** The slice of the @zernio/node client we use; tests inject a fake. */
export interface ZernioMessagesApi {
  sendInboxMessage(args: {
    path: { conversationId: string };
    headers: { "Idempotency-Key": string };
    body: { accountId: string; message: string };
  }): Promise<{ data?: { data?: { messageId?: string } } | undefined }>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Retry 5xx and network errors. OFF by default: Zernio documents that a 5xx on a send is ambiguous
   * (the platform may already have accepted the message) and that it releases the Idempotency-Key,
   * so a blind retry can message the customer twice. Turn on only with a reconcile step.
   */
  retryOnServerError: boolean;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  retryOnServerError: false,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** WhatsApp per-recipient pacing limit. Zernio returns it as HTTP 400, code "131056"; it is rate limiting, not a validation error. */
const WHATSAPP_RECIPIENT_RATE_LIMIT = "131056";

export class ZernioSendError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "ZernioSendError";
  }
}

interface ApiErrorLike {
  statusCode?: number;
  code?: string;
  getSecondsUntilReset?: () => number | undefined;
}

function describe(err: unknown): ApiErrorLike {
  return typeof err === "object" && err !== null ? (err as ApiErrorLike) : {};
}

type Verdict = { retry: false } | { retry: true; minDelayMs: number };

function classify(err: unknown, policy: RetryPolicy): Verdict {
  const { statusCode, code, getSecondsUntilReset } = describe(err);
  if (statusCode === 429) {
    const s = typeof getSecondsUntilReset === "function" ? getSecondsUntilReset.call(err) : undefined;
    return { retry: true, minDelayMs: s !== undefined ? s * 1000 : 0 };
  }
  if (statusCode === 400 && code === WHATSAPP_RECIPIENT_RATE_LIMIT) {
    return { retry: true, minDelayMs: 6_000 }; // ~10 messages/minute per recipient
  }
  if (policy.retryOnServerError && (statusCode === undefined || statusCode >= 500)) {
    return { retry: true, minDelayMs: 0 };
  }
  return { retry: false }; // other 4xx (validation, auth, closed 24h window, ...) will not succeed on retry
}

export class ZernioSender {
  private readonly policy: RetryPolicy;

  constructor(
    private readonly api: ZernioMessagesApi,
    retry: Partial<RetryPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RETRY, ...retry };
  }

  async sendText(target: SendTarget, body: string, opts: SendOptions): Promise<SendResult> {
    if (!body.trim()) throw new ZernioSendError("empty message body", undefined, "invalid_argument", 0);
    if (!opts.idempotencyKey || opts.idempotencyKey.length > 255) {
      throw new ZernioSendError("idempotencyKey must be 1-255 characters", undefined, "invalid_argument", 0);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.api.sendInboxMessage({
          path: { conversationId: target.conversationId },
          headers: { "Idempotency-Key": opts.idempotencyKey },
          body: { accountId: target.accountId, message: body },
        });
        return { messageId: res.data?.data?.messageId, attempts: attempt };
      } catch (err) {
        const verdict = classify(err, this.policy);
        const { statusCode, code } = describe(err);
        if (!verdict.retry || attempt >= this.policy.maxAttempts) {
          // Do not forward upstream text: it can echo the recipient or the message.
          throw new ZernioSendError(
            `Zernio send failed (status ${statusCode ?? "n/a"}, code ${code ?? "n/a"}) after ${attempt} attempt(s)`,
            statusCode,
            code,
            attempt,
          );
        }
        const backoff = Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs);
        await this.policy.sleep(Math.min(Math.max(backoff, verdict.minDelayMs), this.policy.maxDelayMs));
      }
    }
  }
}

/** Builds the real sender around the official SDK. Never used in tests. */
export function createZernioSender(apiKey: string, retry: Partial<RetryPolicy> = {}): ZernioSender {
  const zernio = new Zernio({ apiKey, timeout: 15_000 });
  const api: ZernioMessagesApi = {
    sendInboxMessage: (args) => zernio.messages.sendInboxMessage(args) as ReturnType<ZernioMessagesApi["sendInboxMessage"]>,
  };
  return new ZernioSender(api, retry);
}
