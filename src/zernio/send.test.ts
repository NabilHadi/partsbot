import { describe, expect, it, vi } from "vitest";
import { ZernioSendError, ZernioSender, type ZernioMessagesApi } from "./send.js";

const target = { conversationId: "conv1", accountId: "acc1" };
const opts = { idempotencyKey: "key-1" };

class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code?: string, private readonly resetSeconds?: number) {
    super("upstream says something with +966500000000");
  }
  getSecondsUntilReset() {
    return this.resetSeconds;
  }
}

function fakeApi(results: Array<unknown>) {
  const calls: Array<Parameters<ZernioMessagesApi["sendInboxMessage"]>[0]> = [];
  const api: ZernioMessagesApi = {
    sendInboxMessage: async (args) => {
      calls.push(args);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next as never;
    },
  };
  return { api, calls };
}

const ok = { data: { data: { messageId: "wamid.OUT" } } };

describe("ZernioSender.sendText", () => {
  it("sends once with the idempotency key, conversation and account", async () => {
    const { api, calls } = fakeApi([ok]);
    const res = await new ZernioSender(api).sendText(target, "hello", opts);
    expect(res).toEqual({ messageId: "wamid.OUT", attempts: 1 });
    expect(calls).toEqual([
      { path: { conversationId: "conv1" }, headers: { "Idempotency-Key": "key-1" }, body: { accountId: "acc1", message: "hello" } },
    ]);
  });

  it("retries 429 with backoff, honouring the reset time, reusing the same idempotency key", async () => {
    const { api, calls } = fakeApi([new ApiError(429, undefined, 3), new ApiError(429), ok]);
    const sleep = vi.fn(async (_ms: number) => {});
    const res = await new ZernioSender(api, { sleep, baseDelayMs: 100 }).sendText(target, "hi", opts);
    expect(res.attempts).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000, 200]);
    expect(new Set(calls.map((c) => c.headers["Idempotency-Key"]))).toEqual(new Set(["key-1"]));
  });

  it("treats WhatsApp 131056 (per-recipient pacing, HTTP 400) as rate limiting", async () => {
    const { api } = fakeApi([new ApiError(400, "131056"), ok]);
    const sleep = vi.fn(async () => {});
    await new ZernioSender(api, { sleep }).sendText(target, "hi", opts);
    expect(sleep).toHaveBeenCalledWith(6000);
  });

  it("never retries other 4xx", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const { api, calls } = fakeApi([new ApiError(status, "X")]);
      await expect(new ZernioSender(api, { sleep: async () => {} }).sendText(target, "hi", opts)).rejects.toMatchObject({
        name: "ZernioSendError",
        status,
        attempts: 1,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("does not retry 5xx by default (ambiguous send, key is released)", async () => {
    const { api, calls } = fakeApi([new ApiError(500), ok]);
    await expect(new ZernioSender(api, { sleep: async () => {} }).sendText(target, "hi", opts)).rejects.toBeInstanceOf(ZernioSendError);
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx and network errors when opted in", async () => {
    const { api, calls } = fakeApi([new ApiError(503), new Error("socket hang up"), ok]);
    const res = await new ZernioSender(api, { sleep: async () => {}, retryOnServerError: true }).sendText(target, "hi", opts);
    expect(res.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts and does not leak upstream text", async () => {
    const { api, calls } = fakeApi([new ApiError(429), new ApiError(429), new ApiError(429)]);
    const err = (await new ZernioSender(api, { sleep: async () => {}, maxAttempts: 3 })
      .sendText(target, "hi", opts)
      .catch((e: unknown) => e)) as ZernioSendError;
    expect(err).toBeInstanceOf(ZernioSendError);
    expect(err.status).toBe(429);
    expect(err.attempts).toBe(3);
    expect(err.message).not.toContain("966");
    expect(calls).toHaveLength(3);
  });

  it("validates arguments before calling the API", async () => {
    const { api, calls } = fakeApi([ok]);
    const s = new ZernioSender(api);
    await expect(s.sendText(target, "  ", opts)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(s.sendText(target, "hi", { idempotencyKey: "" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(s.sendText(target, "hi", { idempotencyKey: "k".repeat(256) })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(calls).toHaveLength(0);
  });
});
