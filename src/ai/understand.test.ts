import { describe, expect, it } from "vitest";
import { buildUnderstandUser, inventedTokens, understandMessage } from "./understand.js";
import { failWith, scriptedProvider, understanding } from "./testkit.js";

const input = { text: "ابي قماشات قدام للكامري", history: [], vehicle: null, language: "auto" as const, waitingFor: null, lastPart: null };

describe("understandMessage", () => {
  it("returns validated data", async () => {
    const u = understanding({ parts: [{ customer_words: "قماشات قدام", normalized_en: "brake pads", normalized_ar: "فحمات فرامل", position: "front" }] });
    const p = scriptedProvider(() => u);
    const r = await understandMessage(p, input);
    expect(r.ok && r.data.parts[0]?.normalized_ar).toBe("فحمات فرامل");
    expect(p.calls[0]!.temperature).toBeLessThanOrEqual(0.2);
    expect(p.calls[0]!.user).toContain("<<<\nابي قماشات قدام للكامري\n>>>");
  });

  it("schema violations fall back (reason schema_invalid)", async () => {
    const r = await understandMessage(scriptedProvider(() => ({ intent: "buy_car", parts: [] })), input);
    expect(r).toMatchObject({ ok: false, reason: "schema_invalid" });
  });

  it("a part number the customer never typed is rejected (invented_part_number)", async () => {
    const u = understanding({ parts: [{ customer_words: "قماشات", normalized_en: "brake pads 04465-06090", normalized_ar: "فحمات فرامل" }] });
    expect(inventedTokens(u, input.text)).toEqual(["04465-06090"]);
    const r = await understandMessage(scriptedProvider(() => u), input);
    expect(r).toMatchObject({ ok: false, reason: "invented_part_number" });
  });

  it("a number the customer typed may be echoed", () => {
    const u = understanding({ parts: [{ customer_words: "04465-06090", normalized_en: "04465-06090", normalized_ar: "04465-06090" }] });
    expect(inventedTokens(u, "عندك ٠٤٤٦٥-٠٦٠٩٠ ؟")).toEqual([]);
  });

  it("provider errors become a reason code", async () => {
    expect(await understandMessage(scriptedProvider(failWith("timeout")), input)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("the prompt fences the customer's message and carries context", () => {
    const u = buildUnderstandUser({ ...input, vehicle: "Toyota Land Cruiser 2022", lastPart: "فحمات فرامل أمامية", history: [{ from: "bot", text: "تفضل" }] });
    expect(u).toContain("Remembered vehicle: Toyota Land Cruiser 2022");
    expect(u).toContain("Last part searched: فحمات فرامل أمامية");
    expect(u).toContain("shop bot: تفضل");
  });
});
