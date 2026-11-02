import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conversation } from "./conversation-driver.js";
import type { OneEpcLike } from "./engine.js";
import { findPartNumberLikeTokens } from "./guard.js";
import { failing, recording, searchFailing, startMock } from "./testkit.js";

const LC = "TESTLC20220000001";
const TUCSON = "TESTHY20210000002";
const HILUX_AMBIGUOUS = "TESTAMB2020000003";
const UNKNOWN = "TESTNF00000000004";
const BMW = "TESTBMW2020000005";

let mock: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

const botTexts = (c: Conversation) => c.turns.filter((t) => t.from === "bot").map((t) => t.text);
const newConv = (oneepc: OneEpcLike = mock.client, shop: Record<string, unknown> = {}) => new Conversation(oneepc, shop);

/** Every part-number-like token in the bot's messages must be one the (mock) API returned. */
function expectOnlyApiNumbers(c: Conversation, rec: { partNumbers: Set<string> }) {
  for (const text of botTexts(c)) {
    for (const tok of findPartNumberLikeTokens(text)) expect(rec.partNumbers.has(tok), `invented: ${tok}`).toBe(true);
  }
}

describe("exact VIN -> confirm -> search -> confirmed part", () => {
  it("part first, VIN second: asks for the VIN, then quotes the catalogue number", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r1 = await c.say("السلام عليكم ابغى فلتر زيت");
    expect(r1.replies).toHaveLength(1);
    expect(r1.newState.step).toBe("awaiting_vin");
    expect(r1.newState.pendingPart).toBe("فلتر زيت");
    expect(rec.calls).toEqual([]);

    const r2 = await c.say(LC);
    expect(r2.replies).toHaveLength(1);
    expect(r2.replies[0]).toContain("00000-EXAMPLE4");
    expect(r2.replies[0]).toContain("لاند كروزر");
    expect(r2.replies[0]).not.toContain("00000-EXAMPLE6"); // the 0.5-score air filter is not quoted
    expect(r2.replies[0]).not.toMatch(/ريال|سعر|SAR/);
    expect(r2.actions.some((a) => a.type === "handoff")).toBe(false);
    expectOnlyApiNumbers(c, rec);
  });

  it("VIN first: confirms the vehicle, 'yes', then the part", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r1 = await c.say(LC);
    expect(r1.replies).toHaveLength(1);
    expect(r1.replies[0]).toContain("لاند كروزر");
    expect(findPartNumberLikeTokens(r1.replies[0] ?? "")).toEqual([]);
    expect(r1.newState.step).toBe("awaiting_part");
    await c.say("نعم");
    const r3 = await c.say("فلتر زيت");
    expect(r3.replies[0]).toContain("00000-EXAMPLE4");
    expectOnlyApiNumbers(c, rec);
  });

  it("'no' to the vehicle clears it and asks for the right VIN", async () => {
    const c = newConv();
    await c.say(LC);
    const r = await c.say("لا");
    expect(r.newState.vehicle).toBeNull();
    expect(r.newState.step).toBe("awaiting_vin");
    expect(r.replies).toHaveLength(1);
  });

  it("uses the English name when name.ar is null (no translation)", async () => {
    const c = newConv();
    await c.say(LC);
    const r = await c.say("فلتر هواء");
    expect(r.replies[0]).toContain("Filter, air cleaner: 00000-EXAMPLE6");
  });

  it("Arabic-Indic digits in the VIN", async () => {
    const c = newConv();
    const r = await c.say("TESTLC٢٠٢٢٠٠٠٠٠٠١");
    expect(r.newState.vin).toBe(LC);
    expect(r.replies[0]).toContain("لاند كروزر");
  });

  it("a VIN with spaces and dashes, lower case", async () => {
    const c = newConv();
    const r = await c.say("testlc-2022 0000001");
    expect(r.newState.vin).toBe(LC);
  });

  it("'this is the chassis <VIN>' does not replace the part asked for earlier", async () => {
    const c = newConv();
    await c.say("ابغى فلتر زيت");
    const r = await c.say(`هذا الشاصي ${LC}`);
    expect(r.replies[0]).toContain("00000-EXAMPLE4");
  });

  it("part + VIN in one message answers in one reply", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r = await c.say(`فلتر زيت ${LC}`);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("00000-EXAMPLE4");
    expectOnlyApiNumbers(c, rec);
  });
});

describe("ambiguous VIN -> variant question -> pick -> continue", () => {
  it("asks which variant and never searches before the answer", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    await c.say("عندكم فلتر زيت؟");
    const r2 = await c.say(HILUX_AMBIGUOUS);
    expect(r2.newState.step).toBe("awaiting_variant");
    expect(r2.replies).toHaveLength(1);
    expect(r2.replies[0]).toMatch(/1\).*\n2\)/s);
    expect(rec.calls).toEqual(["decode"]);
    expect(findPartNumberLikeTokens(r2.replies[0] ?? "")).toEqual([]);

    const r3 = await c.say("2");
    expect(r3.replies).toHaveLength(1);
    expect(r3.replies[0]).toContain("00000-EXAMPLE4");
    expect(rec.calls).toEqual(["decode", "search"]);
    expectOnlyApiNumbers(c, rec);
  });

  it("an unclear answer re-asks once, it never guesses", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    await c.say(HILUX_AMBIGUOUS);
    const r = await c.say("مدري");
    expect(r.newState.step).toBe("awaiting_variant");
    expect(r.replies).toHaveLength(1);
    expect(rec.calls).toEqual(["decode"]);
  });

  it("repeated unclear answers hand off", async () => {
    const c = newConv();
    await c.say(HILUX_AMBIGUOUS);
    let last = await c.say("مدري");
    for (let i = 0; i < 3 && last.newState.step !== "handoff"; i++) last = await c.say("مدري برضو");
    expect(last.newState.step).toBe("handoff");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "variant_unclear" });
  });
});

describe("conditional / ambiguous search -> never states it fits", () => {
  it("asks the API's question_hint, and a failed clarification becomes a handoff with no part number", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    await c.say("ابغى فحمات قدام");
    const r2 = await c.say(LC);
    expect(r2.newState.step).toBe("awaiting_clarification");
    expect(r2.replies).toHaveLength(1);
    expect(r2.replies[0]).toContain("17 أو 18 إنش"); // the API's own question_hint.ar
    expect(findPartNumberLikeTokens(r2.replies[0] ?? "")).toEqual([]);

    const r3 = await c.say("17");
    expect(r3.replies).toHaveLength(1);
    expect(r3.replies[0]).toContain("يرجى التأكيد مع الموظف");
    expect(r3.newState.step).toBe("handoff");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "clarification_failed" });
    for (const t of botTexts(c)) expect(findPartNumberLikeTokens(t)).toEqual([]);
    expect(rec.partNumbers.size).toBeGreaterThan(0); // the API did return numbers: the bot just did not quote them
  });
});

describe("unknown / unsupported VIN -> handoff", () => {
  it("unknown VIN hands off, then stays silent (and flags the waiting customer)", async () => {
    const c = newConv();
    const r1 = await c.say(`${UNKNOWN} فلتر زيت`);
    expect(r1.replies).toHaveLength(1);
    expect(r1.newState.step).toBe("handoff");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "unknown_vin" });
    const r2 = await c.say("هلا؟ فيه أحد؟");
    expect(r2.replies).toEqual([]);
    expect(r2.actions).toContainEqual({ type: "customer_waiting" });
  });
  it("unsupported brand hands off", async () => {
    const c = newConv();
    const r = await c.say(BMW);
    expect(r.replies).toHaveLength(1);
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "unsupported_brand" });
  });
  it("silence ends after the handoff window and the conversation restarts", async () => {
    const c = newConv();
    await c.say(UNKNOWN);
    const r = await c.say("فلتر زيت", 13 * 60); // 13 h later
    expect(r.replies).toHaveLength(1);
    expect(r.newState.step).toBe("awaiting_vin");
  });
});

describe("invalid VIN", () => {
  it("explains once, never fixes the characters, and eventually hands off", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r1 = await c.say("TESTLC2022000000O"); // letter O
    expect(r1.replies).toHaveLength(1);
    expect(rec.calls).toEqual([]);
    let last = r1;
    for (let i = 0; i < 4 && last.newState.step !== "handoff"; i++) last = await c.say("TESTLC2022000000O");
    expect(last.newState.step).toBe("handoff");
    expect(rec.calls).toEqual([]);
  });
});

describe("VINs only: a frame number gets a polite ask for the 17-character VIN", () => {
  it("never decodes a frame number, asks for رقم الهيكل (17), keeps the part, and hands off after repeated tries", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r1 = await c.say("ابي فلتر زيت GGN120-0001234");
    expect(r1.replies).toHaveLength(1);
    expect(r1.replies[0]).toContain("رقم الهيكل");
    expect(r1.replies[0]).toContain("17");
    expect(r1.newState).toMatchObject({ step: "awaiting_vin", pendingPart: "فلتر زيت" });
    expect(rec.calls).toEqual([]);
    let last = r1;
    for (let i = 0; i < 5 && last.newState.step !== "handoff"; i++) last = await c.say("GGN1200001234");
    expect(last.newState.step).toBe("handoff");
    expect(last.actions).toContainEqual({ type: "handoff", reason: "invalid_vin_repeated" });
    expect(c.turns.filter((t) => t.from === "bot")).toHaveLength(3); // 2 asks + the handoff, no endless loop
    expect(rec.calls).toEqual([]);
  });

  it("the VIN after a frame number is accepted normally", async () => {
    const c = newConv();
    await c.say("M900A-0123456");
    const r = await c.say(`${LC} فلتر زيت`);
    expect(r.replies.join("\n")).toContain("00000-EXAMPLE4");
  });
});

describe("runtime part-number guard", () => {
  it("blocks a reply that would contain a number the API did not return as a part number", async () => {
    // The API's own text field smuggles in a different number: the guard must stop the whole reply.
    const tampered: OneEpcLike = {
      decode: (v) => mock.client.decode(v),
      searchParts: async (id, p) => {
        const r = await mock.client.searchParts(id, p);
        const first = r.data.results[0];
        if (first) first.name = { ...first.name, ar: "فلتر زيت 04465-0K290", en: "Oil filter 04465-0K290" };
        return r;
      },
    };
    const c = newConv(tampered);
    const r = await c.say(`${LC} فلتر زيت`);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).not.toContain("04465-0K290");
    expect(r.replies[0]).not.toContain("00000-EXAMPLE4");
    expect(r.newState.step).toBe("handoff");
    expect(r.actions).toContainEqual({ type: "handoff", reason: "guard_blocked" });
    expect(r.actions.find((a) => a.type === "alert")).toMatchObject({ code: "part_number_guard_blocked" });
    // the alert detail carries a count, never the customer's text
    expect(JSON.stringify(r.actions)).not.toContain("فلتر");
  });
});

describe("off-topic scope guard", () => {
  it("redirects without calling the catalogue", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    const r = await c.say("اكتب لي قصيدة عن الصحراء");
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("مساعد قطع الغيار");
    expect(rec.calls).toEqual([]);
  });
  it("keeps going off-topic -> hands off instead of chatting", async () => {
    const c = newConv();
    let last = await c.say("وش رايك في الاسهم");
    for (let i = 0; i < 4 && last.newState.step !== "handoff"; i++) last = await c.say("احكي لي نكتة");
    expect(last.newState.step).toBe("handoff");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "off_topic_repeated" });
  });
});

describe("daily cap", () => {
  it("sends ONE final handoff message at the cap, then silence", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec, { maxBotMessagesPerDay: 3 });
    c.botMessages = 3;
    const r1 = await c.say("ابغى فلتر زيت");
    expect(r1.replies).toHaveLength(1);
    expect(r1.replies[0]).toContain("للحد اليومي");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "daily_cap" });
    c.botMessages += 1;
    const r2 = await c.say(LC);
    const r3 = await c.say("هلا");
    expect(r2.replies).toEqual([]);
    expect(r3.replies).toEqual([]);
    expect(r3.actions).toContainEqual({ type: "customer_waiting" });
    expect(rec.calls).toEqual([]); // no API cost either
  });
  it("hits the cap mid-conversation", async () => {
    const c = newConv(mock.client, { maxBotMessagesPerDay: 2 });
    const r1 = await c.say("ابغى فلتر زيت"); // message 1
    const r2 = await c.say(LC); // message 2 (quote)
    expect(r1.replies).toHaveLength(1);
    expect(r2.replies[0]).toContain("00000-EXAMPLE4");
    const r3 = await c.say("وفلتر هواء"); // cap reached: one final message
    expect(r3.replies).toHaveLength(1);
    expect(r3.replies[0]).toContain("للحد اليومي");
    const r4 = await c.say("هلا");
    expect(r4.replies).toEqual([]);
  });
});

describe("OneEPC errors -> safe handoff + alert", () => {
  for (const [status, code] of [
    [429, "rate_limited"],
    [503, "upstream_unavailable"],
    [500, "internal_error"],
  ] as const) {
    it(`decode ${status} ${code}`, async () => {
      const c = newConv(failing(status, code));
      const r = await c.say(`${LC} فلتر زيت`);
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]).not.toContain("SECRET-UPSTREAM-TEXT");
      expect(r.replies[0]).not.toMatch(/\b(429|503|500)\b/);
      expect(r.newState.step).toBe("handoff");
      expect(r.actions).toContainEqual({ type: "handoff", reason: "oneepc_error" });
      const alert = r.actions.find((a) => a.type === "alert");
      expect(alert).toMatchObject({ type: "alert" });
      expect(JSON.stringify(r.actions)).not.toContain("SECRET-UPSTREAM-TEXT");
      expect(JSON.stringify(r.actions)).toContain("req_failing"); // request id is what ops needs
    });
  }
  it("search 503 after a successful decode", async () => {
    const c = newConv(searchFailing(mock.client, 503, "upstream_unavailable"));
    const r = await c.say(`${LC} فلتر زيت`);
    expect(r.replies).toHaveLength(1);
    expect(r.newState.step).toBe("handoff");
    expect(r.replies[0]).not.toContain("00000-EXAMPLE");
  });
});

describe("English customer", () => {
  it("replies in English, with the catalogue number (shop language: auto)", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec, { language: "auto" });
    const r1 = await c.say("hi, I need front brake pads");
    expect(r1.newState.lang).toBe("en");
    expect(r1.replies[0]).toMatch(/VIN/);
    expect(r1.replies[0]).not.toMatch(/[\u0600-\u06FF]/);
    const r2 = await c.say(TUCSON);
    expect(r2.replies).toHaveLength(1);
    expect(r2.replies[0]).toContain("00000-EXAMPLE3");
    expect(r2.replies[0]).not.toMatch(/[\u0600-\u06FF]/);
    expectOnlyApiNumbers(c, rec);
  });
  it("English off-topic and staff request (shop language: auto)", async () => {
    const c = newConv(mock.client, { language: "auto" });
    const r = await c.say("what is the weather today");
    expect(r.replies[0]).toMatch(/car-parts/);
    const r2 = await c.say("I want to talk to a person");
    expect(r2.newState.step).toBe("handoff");
    expect(r2.replies[0]).not.toMatch(/[\u0600-\u06FF]/);
  });
});

describe("misc", () => {
  it("a customer asking for staff is handed off", async () => {
    const c = newConv();
    const r = await c.say("ابي اكلم موظف");
    expect(r.newState.step).toBe("handoff");
    expect(c.allActions).toContainEqual({ type: "handoff", reason: "customer_request" });
  });
  it("non-text messages get the text-only notice (one message)", async () => {
    const c = newConv();
    const r = await c.say(null);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("النصية");
  });
  it("a new part after a quote reuses the vehicle without re-asking the VIN", async () => {
    const rec = recording(mock.client);
    const c = newConv(rec);
    await c.say(`${LC} فلتر زيت`);
    const r = await c.say("وفلتر هواء");
    expect(r.replies[0]).toContain("00000-EXAMPLE6");
    expect(rec.calls.filter((x) => x === "decode")).toHaveLength(1);
  });
  it("session TTL: after 3 hours of silence the conversation starts again", async () => {
    const c = newConv();
    await c.say(`${LC}`);
    const r = await c.say("فلتر زيت", 180);
    expect(r.newState.vehicle).toBeNull();
    expect(r.newState.step).toBe("awaiting_vin");
  });
  it("'start over' keyword resets", async () => {
    const c = newConv();
    await c.say(LC);
    const r = await c.say("ابدأ من جديد");
    expect(r.newState.vehicle).toBeNull();
    expect(r.replies).toHaveLength(1);
  });
  it("thanks gets no reply after an answer", async () => {
    const c = newConv();
    await c.say(`${LC} فلتر زيت`);
    const r = await c.say("شكرا");
    expect(r.replies).toEqual([]);
  });
  it("never more than one reply per turn", async () => {
    const c = newConv();
    for (const m of ["هلا", "ابغى فلتر", LC, "نعم", "فحمات", "17", "شكرا", "هلا"]) {
      const r = await c.say(m);
      expect(r.replies.length).toBeLessThanOrEqual(1);
    }
  });
});
