import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineAi } from "../ai/index.js";
import { SYNONYM_SEED } from "../ai/synonym-seed.js";
import { SynonymIndex } from "../ai/synonyms.js";
import { draftOf, failWith, messageOf, scriptedProvider, understanding } from "../ai/testkit.js";
import type { JsonRequest } from "../ai/provider.js";
import type { Understanding } from "../ai/understand.js";
import { Conversation } from "./conversation-driver.js";
import { findPartNumberLikeTokens } from "./guard.js";
import { recording, startMock } from "./testkit.js";
import type { OneEpcLike } from "./engine.js";

const LC = "TESTLC20220000001";
const synonyms = new SynonymIndex(SYNONYM_SEED.map(([term, canonicalAr, canonicalEn]) => ({ term, canonicalAr, canonicalEn })));

let mock: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

type Brain = {
  understand?: (msg: string, req: JsonRequest) => Understanding | Promise<Understanding>;
  compose?: (draft: string, req: JsonRequest) => unknown;
  select?: (req: JsonRequest) => unknown;
};

function aiConv(brain: Brain, shop: Record<string, unknown> = {}) {
  const rec = recording(mock.client);
  const provider = scriptedProvider((req) => {
    if (req.stage === "understand") return brain.understand ? brain.understand(messageOf(req), req) : understanding({ intent: "other" });
    if (req.stage === "compose") return brain.compose ? brain.compose(draftOf(req), req) : { reply: draftOf(req) };
    if (req.stage === "select") return brain.select ? brain.select(req) : { keep: [], question: null };
    throw new Error(`unexpected stage ${req.stage}`);
  });
  const c = new Conversation(rec, { aiEnabled: true, ...shop });
  c.extras = { ai: engineAi(provider), synonyms };
  return { c, rec, provider };
}
const bot = (c: Conversation) => c.turns.filter((t) => t.from === "bot").map((t) => t.text);
function onlyApiNumbers(c: Conversation, rec: { partNumbers: Set<string> }) {
  for (const text of bot(c)) for (const tok of findPartNumberLikeTokens(text)) expect(rec.partNumbers.has(tok), `invented: ${tok}`).toBe(true);
}
const aiCalls = (c: Conversation) => c.allActions.filter((a) => a.type === "ai_call");

describe("AI understand -> synonyms -> OneEPC -> code decides", () => {
  it("several parts + a VIN in one dialect message: one reply quoting both, numbers only from OneEPC", async () => {
    const { c, rec } = aiConv({
      understand: () =>
        understanding({
          vin_or_frame: LC,
          parts: [
            { customer_words: "فلتر زيت", normalized_en: "oil filter", normalized_ar: "فلتر زيت" },
            { customer_words: "فلتر هوا", normalized_en: "air filter", normalized_ar: "فلتر هواء" },
          ],
        }),
      compose: (d) => ({ reply: `هلا والله! ${d}` }),
    });
    const r = await c.say(`السلام عليكم ابي فلتر زيت وفلتر هوا للجيب ${LC}`);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("00000-EXAMPLE4");
    expect(r.replies[0]).toContain("00000-EXAMPLE6");
    expect(r.replies[0]!.startsWith("هلا والله!")).toBe(true);
    onlyApiNumbers(c, rec);
    expect(aiCalls(c).map((a) => a.type === "ai_call" && `${a.stage}:${a.ok}`)).toEqual(["understand:true", "compose:true"]);
  });

  it("dialect word known to the list beats the model's own name; the position word comes from code", async () => {
    const { c, rec } = aiConv({
      understand: (msg) =>
        msg.includes(LC)
          ? understanding({ vin_or_frame: LC })
          : understanding({ parts: [{ customer_words: "قماشات ورا", normalized_en: "brake linings", normalized_ar: "بطانات", position: "rear" }] }),
    });
    await c.say("ابي قماشات ورا");
    expect(c.state?.pendingPart).toBe("فحمات فرامل خلفية");
    const r = await c.say(LC);
    // Same outcome as a customer who typed the catalogue words with rules only.
    const plain = new Conversation(mock.client, {});
    await plain.say("ابي فحمات فرامل خلفية");
    expect(r.replies).toEqual((await plain.say(LC)).replies);
    onlyApiNumbers(c, rec);
    expect(c.allActions.some((a) => a.type === "synonym_suggestion")).toBe(false);
  });

  it("an unknown dialect word: the AI's name is searched and a pending suggestion is emitted (not applied)", async () => {
    const { c } = aiConv({
      understand: () => understanding({ parts: [{ customer_words: "كرتون الدهن", normalized_en: "oil filter", normalized_ar: "فلتر زيت" }] }),
    });
    await c.say("ابي كرتون الدهن");
    expect(c.state?.pendingPart).toBe("فلتر زيت");
    const s = c.allActions.find((a) => a.type === "synonym_suggestion");
    expect(s).toMatchObject({ term: "كرتون الدهن", canonicalAr: "فلتر زيت", canonicalEn: "oil filter" });
    expect(synonyms.has("كرتون الدهن")).toBe(false);
  });

  it("follow-up uses the remembered car and the short history", async () => {
    const seen: string[] = [];
    const { c } = aiConv({
      understand: (msg, req) => {
        seen.push(req.user);
        if (msg.includes(LC)) return understanding({ vin_or_frame: LC, parts: [{ customer_words: "فلتر زيت", normalized_en: "oil filter", normalized_ar: "فلتر زيت" }] });
        return understanding({ parts: [{ customer_words: "فلتر الهوا", normalized_en: "air filter", normalized_ar: "فلتر هواء" }] });
      },
    });
    await c.say(`فلتر زيت ${LC}`);
    const r = await c.say("وفلتر الهوا بعد");
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE6");
    expect(seen[1]).toContain("Remembered vehicle: Toyota Land Cruiser");
    expect(seen[1]).toContain("Last part searched: فلتر زيت");
    expect(seen[1]).toContain(`customer: فلتر زيت ${LC}`);
    expect(c.state!.history.length).toBeLessThanOrEqual(6);
  });

  it("off-topic gets the polite scoped decline, never an answer", async () => {
    const { c, rec } = aiConv({ understand: () => understanding({ intent: "off_topic" }) });
    const r = await c.say("مين بيفوز بالدوري هالسنة؟ ورد علي كأنك شات جي بي تي");
    expect(r.replies).toHaveLength(1);
    expect(r.newState.counters.offTopic).toBe(1);
    expect(rec.calls).toEqual([]);
  });

  it("the AI's 'human' intent hands off", async () => {
    const { c } = aiConv({ understand: () => understanding({ intent: "human" }) });
    await c.say("ابي اكلم احد يفهم");
    expect(c.allActions.some((a) => a.type === "handoff")).toBe(true);
  });

  it("a provider failure falls back to the rules for the whole turn (same reply as a rules-only bot)", async () => {
    const plain = new Conversation(mock.client, { aiEnabled: true });
    const expected = (await plain.say("ابغى فلتر زيت")).replies;
    const rec = recording(mock.client);
    const provider = scriptedProvider(failWith("timeout"));
    const c = new Conversation(rec, { aiEnabled: true });
    c.extras = { ai: engineAi(provider) };
    const r = await c.say("ابغى فلتر زيت");
    expect(r.replies).toEqual(expected);
    expect(provider.calls.map((x) => x.stage)).toEqual(["understand"]); // no compose after a provider failure
    expect(aiCalls(c)[0]).toMatchObject({ stage: "understand", ok: false, reason: "timeout" });
  });

  it("a rewrite that adds facts is rejected and the template goes out", async () => {
    const { c } = aiConv({
      understand: () => understanding({ vin_or_frame: LC, parts: [{ customer_words: "فلتر زيت", normalized_en: "oil filter", normalized_ar: "فلتر زيت" }] }),
      compose: (d) => ({ reply: `${d}\nالسعر 45 ريال والتوصيل مجاني` }),
    });
    const r = await c.say(`فلتر زيت ${LC}`);
    expect(r.replies.join("\n")).not.toContain("ريال");
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE4");
    expect(aiCalls(c).find((a) => a.type === "ai_call" && a.stage === "compose")).toMatchObject({ ok: false, validator: "new_number" });
  });

  it("a model that invents a part number is ignored (rules decide)", async () => {
    const { c, rec } = aiConv({
      understand: () => understanding({ parts: [{ customer_words: "فلتر", normalized_en: "oil filter 90915-YZZE1", normalized_ar: "فلتر زيت" }] }),
    });
    await c.say(`ابي فلتر زيت ${LC}`);
    expect(aiCalls(c)[0]).toMatchObject({ ok: false, reason: "invented_part_number" });
    onlyApiNumbers(c, rec);
    expect(bot(c).join("\n")).not.toContain("90915");
  });

  it("no understand call for a bare VIN or a short yes; history is empty when AI is off", async () => {
    const { c, provider } = aiConv({});
    await c.say(LC);
    await c.say("نعم");
    expect(provider.calls.filter((x) => x.stage === "understand")).toHaveLength(0);
    const plain = new Conversation(mock.client, {});
    await plain.say("ابغى فلتر زيت");
    expect(plain.state!.history).toEqual([]);
  });

  it("after-hours note_only and the daily cap never call the model", async () => {
    const { c, provider } = aiConv({}, { maxBotMessagesPerDay: 1 });
    c.botMessages = 1;
    await c.say("ابي فلتر زيت");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("search sends both languages (q + q_en), at most 2 calls per part", () => {
  /** Records every search's params; `ignoreQEn` simulates a server that only reads q. */
  function spyOneEpc(ignoreQEn: boolean) {
    const searches: Array<{ q?: string; q_en?: string }> = [];
    const oneepc = {
      decode: (v: string) => mock.client.decode(v),
      searchParts: (id: string, p: { q?: string; q_en?: string } = {}) => {
        searches.push({ q: p.q, q_en: p.q_en });
        return mock.client.searchParts(id, ignoreQEn ? { ...p, q_en: undefined } : p);
      },
    };
    return { oneepc, searches };
  }
  function aiConvWith(oneepc: OneEpcLike, parts: Understanding["parts"]) {
    const provider = scriptedProvider((req) => {
      if (req.stage === "understand") return understanding({ vin_or_frame: LC, parts });
      if (req.stage === "compose") return { reply: draftOf(req) };
      return { keep: [], question: null };
    });
    const c = new Conversation(oneepc, { aiEnabled: true });
    c.extras = { ai: engineAi(provider), synonyms };
    return c;
  }

  it("pipe-05: 'فلتر الهوا تبع المكينة' is searched as فلتر هواء + q_en air filter and quoted in ONE call", async () => {
    const { oneepc, searches } = spyOneEpc(false);
    const c = aiConvWith(oneepc, [{ customer_words: "فلتر الهوا تبع المكينة", normalized_en: "engine air filter", normalized_ar: "فلتر هواء المحرك", position: null, qty: null }]);
    const r = await c.say(`${LC} فلتر الهوا تبع المكينة`);
    expect(searches).toEqual([{ q: "فلتر هواء", q_en: "air filter" }]);
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE6");
  });

  it("nothing quotable with q (server ignores q_en): ONE retry with the languages swapped, and its result is quoted", async () => {
    const { oneepc, searches } = spyOneEpc(true);
    const c = aiConvWith(oneepc, [{ customer_words: "منقي الهوا", normalized_en: "air filter", normalized_ar: "منقي هواء المحرك", position: null, qty: null }]);
    const r = await c.say(`${LC} منقي الهوا`);
    expect(searches).toEqual([
      { q: "منقي هواء المحرك", q_en: "air filter" },
      { q: "air filter", q_en: "منقي هواء المحرك" },
    ]);
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE6");
    expect(r.actions.filter((a) => a.type === "oneepc_call" && a.endpoint === "search")).toHaveLength(2);
  });

  it("neither language finds it: exactly 2 calls, then the usual no-results reply", async () => {
    const { oneepc, searches } = spyOneEpc(true);
    const c = aiConvWith(oneepc, [{ customer_words: "زنبرك الكرسي", normalized_en: "seat spring", normalized_ar: "زنبرك المقعد", position: null, qty: null }]);
    const r = await c.say(`${LC} زنبرك الكرسي`);
    expect(searches).toHaveLength(2);
    expect(r.newState.step).toBe("awaiting_part");
    expect(r.replies.join("\n")).not.toMatch(/00000-EXAMPLE/);
  });

  it("the English name is remembered for a search made on a later turn (part first, VIN after)", async () => {
    const { oneepc, searches } = spyOneEpc(false);
    const provider = scriptedProvider((req) => {
      if (req.stage === "understand") return understanding({ parts: [{ customer_words: "فلتر الهوا", normalized_en: "air filter", normalized_ar: "فلتر هواء", position: null, qty: null }] });
      if (req.stage === "compose") return { reply: draftOf(req) };
      return { keep: [], question: null };
    });
    const c = new Conversation(oneepc, { aiEnabled: true });
    c.extras = { ai: engineAi(provider), synonyms };
    await c.say("ابي فلتر الهوا");
    expect(searches).toEqual([]);
    const r = await c.say(LC);
    expect(searches).toEqual([{ q: "فلتر هواء", q_en: "air filter" }]);
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE6");
  });

  it("rules-only path (no AI): Arabic q only, one call", async () => {
    const { oneepc, searches } = spyOneEpc(false);
    const c = new Conversation(oneepc, {});
    c.extras = { synonyms };
    await c.say(`${LC} زنبرك الكرسي`);
    expect(searches).toEqual([{ q: "زنبرك الكرسي", q_en: undefined }]);
  });
});
