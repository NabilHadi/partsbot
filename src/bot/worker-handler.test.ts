import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundMessageJob } from "../zernio/types.js";
import { InMemoryStockSource } from "../inventory/stock.js";
import { normalizePartNumber, splitOem } from "../inventory/normalize.js";
import { STOCK_TEST_VIN } from "../mock/stock-test-fixtures.js";
import { InMemoryBotStore } from "./store.js";
import { startMock, failing } from "./testkit.js";
import { OneEpcRouting } from "../oneepc/routing.js";
import { processInboundJob, type LogFields, type ReplySender } from "./worker-handler.js";

let mock: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

const PHONE = "+966500000000";
const job = (id: string, text: string | null, extra: Partial<InboundMessageJob> = {}): InboundMessageJob => ({
  source: "zernio", eventId: `evt_${id}`, providerMessageId: id, zernioMessageId: `z_${id}`,
  conversationId: "conv_1", accountId: "acc_1", senderId: "sender_1", senderPhone: PHONE, senderBsuid: null,
  text, attachments: [], sentAt: null, standby: false, isTest: false, receivedAt: "2026-10-25T09:00:00+03:00",
  ...extra,
});

function fakeSender() {
  const sent: Array<{ target: unknown; body: string; key: string | undefined }> = [];
  const sender: ReplySender = {
    async sendText(target, body, opts) {
      sent.push({ target, body, key: opts.idempotencyKey });
      return {};
    },
  };
  return { sender, sent };
}

function setup(over: { dryRun?: boolean; shopConfig?: unknown; oneepc?: Parameters<typeof processInboundJob>[1]["oneepc"] } = {}) {
  const store = new InMemoryBotStore({ id: "shop_1", config: over.shopConfig ?? {} });
  const logs: Array<{ event: string; fields: LogFields }> = [];
  const { sender, sent } = fakeSender();
  let t = new Date("2026-10-25T09:00:00+03:00").getTime();
  const deps = {
    store,
    oneepc: over.oneepc ?? mock.client,
    sender,
    dryRun: over.dryRun ?? false,
    now: () => new Date((t += 60_000)),
    log: (event: string, fields: LogFields = {}) => logs.push({ event, fields }),
  };
  return { store, logs, sent, deps };
}

describe("processInboundJob", () => {
  it("DRY_RUN sends nothing but still runs the flow and saves state", async () => {
    const { deps, sent, logs, store } = setup({ dryRun: true });
    expect(await processInboundJob(job("m1", "ابغى فلتر زيت"), deps)).toBe("replied");
    expect(sent).toEqual([]);
    expect(logs.some((l) => l.event === "dry_run_reply")).toBe(true);
    expect(store.states.size).toBe(1);
    expect(await store.getBotMessagesToday("shop_1", "2026-10-25")).toBe(1);
  });

  it("sends through Zernio with idempotency key <providerMessageId>:<index>", async () => {
    const { deps, sent } = setup();
    await processInboundJob(job("wamid.AAA", "ابغى فلتر زيت"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key).toBe("wamid.AAA:0");
    expect(sent[0]?.target).toEqual({ conversationId: "conv_1", accountId: "acc_1" });
  });

  it("runs the whole conversation across jobs", async () => {
    const { deps, sent } = setup();
    await processInboundJob(job("m1", "ابغى فلتر زيت"), deps);
    await processInboundJob(job("m2", "TESTLC20220000001"), deps);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toContain("00000-EXAMPLE4");
  });

  it("a replayed job is skipped as a duplicate (no second send)", async () => {
    const { deps, sent } = setup();
    expect(await processInboundJob(job("m1", "ابغى فلتر زيت"), deps)).toBe("replied");
    expect(await processInboundJob(job("m1", "ابغى فلتر زيت"), deps)).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });

  it("standby and test events are skipped", async () => {
    const { deps, sent, store } = setup();
    expect(await processInboundJob(job("s1", "هلا", { standby: true }), deps)).toBe("skipped_standby");
    expect(await processInboundJob(job("t1", "هلا", { isTest: true }), deps)).toBe("skipped_test");
    expect(sent).toEqual([]);
    expect(store.states.size).toBe(0);
  });

  it("an unknown WhatsApp account has no shop: skipped, not retried", async () => {
    const store = new InMemoryBotStore({ id: "shop_1", config: {}, zernioAccountId: "other" });
    const { sender, sent } = fakeSender();
    const out = await processInboundJob(job("m1", "هلا"), { store, oneepc: mock.client, sender, dryRun: false, log: () => {} });
    expect(out).toBe("skipped_no_shop");
    expect(sent).toEqual([]);
  });

  it("refuses to run live without a sender", async () => {
    const store = new InMemoryBotStore();
    await expect(
      processInboundJob(job("m1", "هلا"), { store, oneepc: mock.client, sender: null, dryRun: false, log: () => {} }),
    ).rejects.toThrow(/DRY_RUN/);
  });

  it("the daily cap is counted from stored usage: one final message then silence", async () => {
    const { deps, sent, store } = setup({ shopConfig: { maxBotMessagesPerDay: 2 } });
    await processInboundJob(job("m1", "ابغى فلتر زيت"), deps); // 1
    await processInboundJob(job("m2", "TESTLC20220000001"), deps); // 2
    await processInboundJob(job("m3", "وفلتر هواء"), deps); // cap message (3rd send, the final one)
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).toContain("للحد اليومي");
    expect(await processInboundJob(job("m4", "هلا"), deps)).toBe("silent");
    expect(sent).toHaveLength(3);
    expect(await store.getBotMessagesToday("shop_1", "2026-10-25")).toBe(3);
  });

  it("OneEPC failure: safe handoff message goes out, no upstream text anywhere", async () => {
    const { deps, sent, logs } = setup({ oneepc: failing(503, "upstream_unavailable") });
    await processInboundJob(job("m1", "TESTLC20220000001 فلتر زيت"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain("SECRET-UPSTREAM-TEXT");
    expect(logs.some((l) => l.event === "alert")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("SECRET-UPSTREAM-TEXT");
  });

  it("mock-routed catalog: a test shop gets mock results, a real shop gets a handoff and never a mock part number", async () => {
    const routing = new OneEpcRouting({ real: null, mock: mock.client, sources: { decode: "mock", search: "mock" } });
    const run = async (shopConfig: unknown) => {
      const { deps, sent, logs } = setup({ shopConfig });
      const d = { ...deps, oneepcFor: (shop: { testShop: boolean }) => routing.forShop(shop) };
      await processInboundJob(job("m1", "ابغى فلتر زيت"), d);
      await processInboundJob(job("m2", "TESTLC20220000001"), d);
      return { sent, logs };
    };
    const test = await run({ testShop: true });
    expect(test.sent[1]?.body).toContain("00000-EXAMPLE4");
    const real = await run({});
    expect(real.sent.map((m) => m.body).join("\n")).not.toMatch(/EXAMPLE/);
    expect(real.logs.some((l) => l.event === "alert" && l.fields.code === "oneepc_catalog_unavailable" && l.fields.severity === "critical")).toBe(true);
    expect(real.logs.some((l) => l.event === "handoff")).toBe(true);
  });

  it("PDPL: logs never contain message text or the phone number", async () => {
    const { deps, logs } = setup({ dryRun: true });
    await processInboundJob(job("m1", "ابغى فلتر زيت لكامري ٢٠٢٠", { senderPhone: PHONE }), deps);
    await processInboundJob(job("m2", "TESTLC20220000001"), deps);
    const all = JSON.stringify(logs);
    expect(all).not.toContain("فلتر");
    expect(all).not.toContain("TESTLC");
    expect(all).not.toContain(PHONE.slice(4));
    // Not even the reply body. The identified part numbers (catalogue data, not personal) are logged once, for staff.
    const withPn = logs.filter((l) => JSON.stringify(l).includes("EXAMPLE"));
    expect(withPn.map((l) => l.event)).toEqual(["parts_identified"]);
  });
});

describe("processInboundJob: synthetic stock policy", () => {
  const synRow = {
    shopId: "shop_1", partNumberRaw: "04465-06090", partNumberNormalized: normalizePartNumber("04465-06090"),
    oemBase: splitOem("04465-06090").oemBase, variantSuffix: null, qty: 6, priceSar: 300, vatIncluded: true,
    isSynthetic: true, active: true, importedAt: new Date("2026-10-25T08:00:00+03:00"),
  };
  const ask = `${STOCK_TEST_VIN} فحمات فرامل امامية`;
  async function reply(shopConfig: unknown, env: boolean) {
    const { deps, sent } = setup({ shopConfig: { stockDisplay: "quantity", ...(shopConfig as object) } });
    await processInboundJob(job("s1", ask), { ...deps, stock: new InMemoryStockSource([synRow]), allowSyntheticStockEnv: env });
    return sent.map((s) => s.body).join("\n");
  }

  it.each([
    ["real shop, even with allowSyntheticStock and env", { allowSyntheticStock: true, priceQuotingEnabled: true }, true],
    ["test shop without opt-in", { testShop: true, priceQuotingEnabled: true }, false],
  ])("hidden: %s", async (_n, cfg, env) => {
    const body = await reply(cfg, env);
    expect(body).toContain("04465-06090");
    expect(body).not.toMatch(/متوفر \(|ريال|تجريبية/);
  });

  it.each([
    ["test shop + config opt-in", { testShop: true, allowSyntheticStock: true, priceQuotingEnabled: true }, false],
    ["test shop + env opt-in", { testShop: true, priceQuotingEnabled: true }, true],
  ])("shown and marked: %s", async (_n, cfg, env) => {
    const body = await reply(cfg, env);
    expect(body).toContain("متوفر (6) · 300 ريال");
    expect(body).toContain("(بيانات تجريبية)");
  });
});
