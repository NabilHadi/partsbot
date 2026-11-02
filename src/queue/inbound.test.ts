import { describe, expect, it, vi } from "vitest";
import { createPgBossInboundQueue, SINGLETON_SECONDS } from "./inbound.js";

describe("pg-boss inbound queue", () => {
  it("keeps singletonSeconds within pg-boss 10's default archive interval (12h)", async () => {
    // pg-boss throws "throttling interval ... cannot exceed archive interval 43200s" above this.
    expect(SINGLETON_SECONDS).toBeLessThanOrEqual(43_200);
    const send = vi.fn().mockResolvedValue("job-1");
    const q = createPgBossInboundQueue({ send } as never);
    await q.enqueue({} as never, "zernio:wamid.X");
    expect(send.mock.calls[0]?.[2]).toMatchObject({ singletonKey: "zernio:wamid.X", singletonSeconds: SINGLETON_SECONDS });
  });
});
