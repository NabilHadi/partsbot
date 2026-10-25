/**
 * Drives the engine for ONE chat in memory: keeps the state, the clock and the daily message counter.
 * Used by the tests, the transcript fixtures and the local chat REPL (npm run chat). No WhatsApp, no DB.
 */
import { handleInbound, type BotAction, type EngineResult, type OneEpcLike } from "./engine.js";
import { parseShopConfig, type ShopConfig } from "./shop-config.js";
import type { ConversationState } from "./state.js";

export interface Turn {
  from: "customer" | "bot";
  text: string;
}

export class Conversation {
  state: ConversationState | null = null;
  readonly shop: ShopConfig;
  /** Bot messages sent so far "today" (the engine uses it for the daily cap). */
  botMessages = 0;
  clock: Date;
  readonly turns: Turn[] = [];
  readonly allActions: BotAction[] = [];
  /** Part numbers the OneEPC fake/mock returned, collected by wrappers (optional, for the "no invented numbers" check). */
  constructor(
    private readonly oneepc: OneEpcLike,
    shop: Partial<Record<string, unknown>> = {},
    start: Date = new Date("2026-10-25T09:00:00+03:00"), // Sunday 09:00 Riyadh: inside the default hours
  ) {
    this.shop = parseShopConfig(shop);
    this.clock = start;
  }

  async say(text: string | null, advanceMinutes = 1): Promise<EngineResult> {
    this.clock = new Date(this.clock.getTime() + advanceMinutes * 60_000);
    if (text !== null) this.turns.push({ from: "customer", text });
    const result = await handleInbound(this.state, text, {
      oneepc: this.oneepc,
      now: () => this.clock,
      shop: this.shop,
      botMessagesToday: this.botMessages,
    });
    this.state = result.newState;
    this.botMessages += result.replies.length;
    for (const r of result.replies) this.turns.push({ from: "bot", text: r });
    this.allActions.push(...result.actions);
    return result;
  }

  /** The text of the most recent bot message, or null. */
  get lastReply(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t?.from === "bot") return t.text;
    }
    return null;
  }

  /** Readable transcript, e.g. for docs and for Nabil to review. */
  toMarkdown(title: string, note?: string): string {
    const lines = [`## ${title}`, ...(note ? ["", `_${note}_`] : []), ""];
    for (const t of this.turns) {
      const quoted = t.text.split("\n").map((l) => `> ${l}`).join("\n");
      lines.push(t.from === "customer" ? `**Customer:**\n${quoted}` : `**Bot:**\n${quoted}`, "");
    }
    const handoff = this.allActions.find((a) => a.type === "handoff");
    if (handoff && handoff.type === "handoff") lines.push(`_→ handoff to staff (${handoff.reason})_`, "");
    return lines.join("\n");
  }
}
