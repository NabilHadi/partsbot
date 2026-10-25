import type { Db } from "../db/pool.js";
import { parseState, type ConversationState } from "./state.js";

/** Everything the worker handler needs from storage. Postgres in production, in-memory in tests and the local chat REPL. */
export interface BotStore {
  /** The shop that owns this Zernio WhatsApp account, with its raw `config` JSON. Null = not onboarded. */
  resolveShop(zernioAccountId: string): Promise<{ id: string; config: unknown } | null>;
  /** Serialise processing per conversation (two jobs for one chat must not interleave). */
  withLock<T>(shopId: string, conversationId: string, fn: () => Promise<T>): Promise<T>;
  getState(shopId: string, conversationId: string, now: Date): Promise<ConversationState | null>;
  saveState(shopId: string, conversationId: string, state: ConversationState, retentionUntil: Date): Promise<void>;
  /** Bot messages sent today (Riyadh date key YYYY-MM-DD) for this shop. */
  getBotMessagesToday(shopId: string, dayKey: string): Promise<number>;
  addUsage(shopId: string, dayKey: string, delta: { botMessages: number; newConversations: number }): Promise<void>;
}

/** How long a conversation's state row lives (PDPL data minimisation); the purge job is a TODO. */
export const STATE_RETENTION_DAYS = 30;

// ------------------------------------------------------------------ in-memory

export class InMemoryBotStore implements BotStore {
  readonly states = new Map<string, ConversationState>();
  readonly usage = new Map<string, { botMessages: number; conversations: number }>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly shop: { id: string; config: unknown; zernioAccountId?: string } = { id: "shop-test", config: {} }) {}

  async resolveShop(zernioAccountId: string) {
    if (this.shop.zernioAccountId && this.shop.zernioAccountId !== zernioAccountId) return null;
    return { id: this.shop.id, config: this.shop.config };
  }

  withLock<T>(shopId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${shopId}:${conversationId}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  async getState(shopId: string, conversationId: string, now: Date) {
    const raw = this.states.get(`${shopId}:${conversationId}`);
    return raw ? parseState(structuredClone(raw), now) : null;
  }

  async saveState(shopId: string, conversationId: string, state: ConversationState) {
    this.states.set(`${shopId}:${conversationId}`, structuredClone(state));
  }

  async getBotMessagesToday(shopId: string, dayKey: string) {
    return this.usage.get(`${shopId}:${dayKey}`)?.botMessages ?? 0;
  }

  async addUsage(shopId: string, dayKey: string, d: { botMessages: number; newConversations: number }) {
    const k = `${shopId}:${dayKey}`;
    const cur = this.usage.get(k) ?? { botMessages: 0, conversations: 0 };
    this.usage.set(k, { botMessages: cur.botMessages + d.botMessages, conversations: cur.conversations + d.newConversations });
  }
}

// ------------------------------------------------------------------ Postgres

export class PgBotStore implements BotStore {
  constructor(private readonly db: Db) {}

  async resolveShop(zernioAccountId: string) {
    const r = await this.db.query<{ id: string; config: unknown }>(
      "SELECT id, config FROM shops WHERE zernio_account_id = $1 AND status = 'active'",
      [zernioAccountId],
    );
    return r.rows[0] ?? null;
  }

  /** Session-level advisory lock on a dedicated connection; released in `finally`. */
  async withLock<T>(shopId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    const key = `${shopId}:${conversationId}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
      client.release();
    }
  }

  async getState(shopId: string, conversationId: string, now: Date) {
    const r = await this.db.query<{ state: unknown }>(
      "SELECT state FROM bot_conversation_state WHERE shop_id = $1 AND zernio_conversation_id = $2",
      [shopId, conversationId],
    );
    return r.rows[0] ? parseState(r.rows[0].state, now) : null;
  }

  async saveState(shopId: string, conversationId: string, state: ConversationState, retentionUntil: Date) {
    await this.db.query(
      `INSERT INTO bot_conversation_state (shop_id, zernio_conversation_id, state, updated_at, retention_until)
       VALUES ($1, $2, $3::jsonb, now(), $4)
       ON CONFLICT (shop_id, zernio_conversation_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now(), retention_until = EXCLUDED.retention_until`,
      [shopId, conversationId, JSON.stringify(state), retentionUntil],
    );
  }

  async getBotMessagesToday(shopId: string, dayKey: string) {
    const r = await this.db.query<{ bot_messages: number }>(
      "SELECT bot_messages FROM usage_counters WHERE shop_id = $1 AND period_type = 'day' AND period_start = $2::date",
      [shopId, dayKey],
    );
    return r.rows[0]?.bot_messages ?? 0;
  }

  async addUsage(shopId: string, dayKey: string, d: { botMessages: number; newConversations: number }) {
    const monthStart = `${dayKey.slice(0, 7)}-01`;
    for (const [type, start] of [["day", dayKey], ["month", monthStart]] as const) {
      await this.db.query(
        `INSERT INTO usage_counters (shop_id, period_type, period_start, bot_messages, conversations)
         VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (shop_id, period_type, period_start)
         DO UPDATE SET bot_messages = usage_counters.bot_messages + EXCLUDED.bot_messages,
                       conversations = usage_counters.conversations + EXCLUDED.conversations`,
        [shopId, type, start, d.botMessages, d.newConversations],
      );
    }
  }
}
