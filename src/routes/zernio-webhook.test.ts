import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { InboundQueue } from "../queue/inbound.js";
import type { DedupeStore } from "../zernio/dedupe.js";
import { computeSignature } from "../zernio/signature.js";
import type { InboundMessageJob } from "../zernio/types.js";

const SECRET = "test-secret-0123456789abcdef";
const URL = "/webhooks/zernio";

class FakeDedupe implements DedupeStore {
  keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  async release(key: string) {
    this.keys.delete(key);
  }
}

class FakeQueue implements InboundQueue {
  jobs: Array<{ job: InboundMessageJob; key: string }> = [];
  fail = false;
  async enqueue(job: InboundMessageJob, key: string) {
    if (this.fail) throw new Error("queue down");
    this.jobs.push({ job, key });
  }
}

function received(over: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    event: "message.received",
    message: {
      id: "m1",
      conversationId: "conv1",
      platform: "whatsapp",
      platformMessageId: "wamid.AAA",
      direction: "incoming",
      text: "front brake pads",
      attachments: [],
      sender: { id: "966500000000", phoneNumber: "+966500000000", name: "X" },
      sentAt: "2026-10-25T12:00:00Z",
      isRead: false,
      someFutureField: { a: 1 },
    },
    conversation: { id: "conv1", platformConversationId: "conv1", status: "active" },
    account: { id: "acc1", accountId: "acc1", platform: "whatsapp", username: "shop" },
    timestamp: "2026-10-25T12:00:00Z",
    ...over,
  };
}

let app: FastifyInstance;
let dedupe: FakeDedupe;
let queue: FakeQueue;

function setup(accountId?: string) {
  dedupe = new FakeDedupe();
  queue = new FakeQueue();
  app = buildServer({ logger: false, zernio: { secret: SECRET, accountId, dedupe, queue, now: () => new Date("2026-10-25T12:00:01Z") } });
}
afterEach(async () => {
  await app.close();
});

async function post(payload: unknown, opts: { secret?: string; signature?: string | null; header?: string; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.signature !== null) {
    headers[opts.header ?? "x-zernio-signature"] = opts.signature ?? computeSignature(body, opts.secret ?? SECRET);
  }
  return app.inject({ method: "POST", url: URL, headers, payload: body });
}

describe("POST /webhooks/zernio", () => {
  it("accepts a validly signed message.received and enqueues it once", async () => {
    setup();
    const res = await post(received());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "queued" });
    expect(queue.jobs).toHaveLength(1);
    const { job, key } = queue.jobs[0]!;
    expect(key).toBe("zernio:wamid.AAA");
    expect(job).toMatchObject({
      eventId: "evt-1",
      providerMessageId: "wamid.AAA",
      conversationId: "conv1",
      accountId: "acc1",
      senderPhone: "+966500000000",
      text: "front brake pads",
      standby: false,
    });
    expect(job).not.toHaveProperty("someFutureField");
  });

  it("accepts the legacy X-Late-Signature header", async () => {
    setup();
    const res = await post(received(), { header: "x-late-signature" });
    expect(res.statusCode).toBe(200);
    expect(queue.jobs).toHaveLength(1);
  });

  it("rejects a tampered body with 401 and no details", async () => {
    setup();
    const good = JSON.stringify(received());
    const sig = computeSignature(good, SECRET);
    const res = await post(null, { raw: good.replace("brake", "clutch"), signature: sig });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    setup();
    const res = await post(received(), { secret: "some-other-secret-0123456789" });
    expect(res.statusCode).toBe(401);
    expect(queue.jobs).toHaveLength(0);
  });

  it("rejects a missing signature", async () => {
    setup();
    const res = await post(received(), { signature: null });
    expect(res.statusCode).toBe(401);
  });

  it("enqueues once when the same delivery is retried", async () => {
    setup();
    const a = await post(received());
    const b = await post(received());
    expect(a.json()).toEqual({ status: "queued" });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ status: "duplicate" });
    expect(queue.jobs).toHaveLength(1);
  });

  it("dedupes on the provider message id even if the event id differs", async () => {
    setup();
    await post(received());
    const res = await post(received({ id: "evt-2" }));
    expect(res.json()).toEqual({ status: "duplicate" });
    expect(queue.jobs).toHaveLength(1);
  });

  it("returns 500 and releases the claim when enqueueing fails, so the retry is processed", async () => {
    setup();
    queue.fail = true;
    const res = await post(received());
    expect(res.statusCode).toBe(500);
    expect(dedupe.keys.size).toBe(0);
    queue.fail = false;
    const retry = await post(received());
    expect(retry.json()).toEqual({ status: "queued" });
    expect(queue.jobs).toHaveLength(1);
  });

  it("400s a signed but malformed payload without echoing it", async () => {
    setup();
    const bad = received();
    delete (bad.message as Record<string, unknown>).platformMessageId;
    const res = await post(bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_payload" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("400s signed non-JSON and payloads without id/event", async () => {
    setup();
    expect((await post(null, { raw: "not json" })).statusCode).toBe(400);
    expect((await post({ hello: "world" })).statusCode).toBe(400);
  });

  it("acknowledges unknown event types with 200 and does nothing", async () => {
    setup();
    for (const event of ["whatsapp.template.status_updated", "some.future.event", "webhook.test"]) {
      const res = await post({ id: "e", event, whatever: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ignored" });
    }
    expect(queue.jobs).toHaveLength(0);
  });

  it("records delivery status events without enqueueing", async () => {
    setup();
    const ev = received({ event: "message.failed", statusAt: "2026-10-25T12:00:00Z", error: { code: 131026, title: "x" } });
    const res = await post(ev);
    expect(res.json()).toEqual({ status: "recorded" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("ignores non-WhatsApp, outgoing and other-account messages", async () => {
    setup("acc1");
    const tg = received();
    (tg.message as Record<string, unknown>).platform = "telegram";
    const out = received({ id: "evt-3" });
    (out.message as Record<string, unknown>).direction = "outgoing";
    const other = received({ id: "evt-4", account: { id: "acc9" } });
    for (const p of [tg, out, other]) {
      expect((await post(p)).json()).toEqual({ status: "ignored" });
    }
    expect(queue.jobs).toHaveLength(0);
  });

  it("flags standby conversations on the job", async () => {
    setup();
    await post(received({ metadata: { standby: true } }));
    expect(queue.jobs[0]!.job.standby).toBe(true);
  });

  it("does not log message text or phone numbers", async () => {
    const lines: string[] = [];
    dedupe = new FakeDedupe();
    queue = new FakeQueue();
    app = buildServer({
      logger: false,
      zernio: { secret: SECRET, dedupe, queue },
    });
    await app.close();
    const { default: Fastify } = await import("fastify");
    const { zernioWebhookRoutes } = await import("./zernio-webhook.js");
    app = Fastify({ logger: { level: "info", stream: { write: (s: string) => void lines.push(s) } } });
    await app.register(zernioWebhookRoutes({ secret: SECRET, dedupe, queue }));
    await post(received());
    await post(received(), { secret: "wrong-secret-0123456789abc" });
    const out = lines.join("");
    expect(out).toContain("wamid.AAA");
    expect(out).not.toContain("front brake pads");
    expect(out).not.toContain("966500000000");
    expect(out).not.toContain(SECRET);
  });

  it("keeps the normal JSON parser on other routes", async () => {
    setup();
    app.post("/other", async (req) => ({ got: (req.body as { a: number }).a }));
    const res = await app.inject({ method: "POST", url: "/other", payload: { a: 1 } });
    expect(res.json()).toEqual({ got: 1 });
  });
});
