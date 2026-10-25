/**
 * Prints a signed curl command for exercising POST /webhooks/zernio locally. Uses FAKE data only.
 *
 *   ZERNIO_WEBHOOK_SECRET=... npx tsx src/scripts/sign-test-payload.ts [received|delivered|test] [--url URL] [--id EVENT_ID] [--wamid ID]
 *
 * Run it with the same secret the server uses. Add `--raw` to print just the JSON body.
 */
import { randomUUID } from "node:crypto";
import { computeSignature } from "../zernio/signature.js";

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith("--") && ["received", "delivered", "test"].includes(a)) ?? "received";
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const secret = process.env.ZERNIO_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set ZERNIO_WEBHOOK_SECRET (same value as the server).");
  process.exit(1);
}

const url = opt("url") ?? "http://localhost:3000/webhooks/zernio";
const eventId = opt("id") ?? randomUUID();
const wamid = opt("wamid") ?? `wamid.TEST${Date.now()}`;
const nowIso = new Date().toISOString();

const account = { id: "acc_test", accountId: "acc_test", platform: "whatsapp", username: "partsbot-test" };
const conversation = { id: "conv_test", platformConversationId: "conv_test", status: "active" };
const message = {
  id: "msg_test",
  conversationId: "conv_test",
  platform: "whatsapp",
  platformMessageId: wamid,
  direction: kind === "received" ? "incoming" : "outgoing",
  text: "TESTVIN123 front brake pads",
  attachments: [],
  sender: { id: "966500000000", phoneNumber: "+966500000000", name: "Test Customer" },
  sentAt: nowIso,
  isRead: false,
};

const payloads = {
  received: { id: eventId, event: "message.received", message, conversation, account, timestamp: nowIso },
  delivered: { id: eventId, event: "message.delivered", message, statusAt: nowIso, conversation, account, timestamp: nowIso },
  test: { id: eventId, event: "webhook.test", message: "This is a test webhook from Zernio", timestamp: nowIso },
} as const;

// Compact JSON, signed byte for byte as sent.
const body = JSON.stringify(payloads[kind as keyof typeof payloads]);
if (args.includes("--raw")) {
  console.log(body);
} else {
  const sig = computeSignature(body, secret);
  console.log(
    [
      `curl -i -X POST '${url}'`,
      `  -H 'Content-Type: application/json'`,
      `  -H 'X-Zernio-Event: ${payloads[kind as keyof typeof payloads].event}'`,
      `  -H 'X-Zernio-Event-Id: ${eventId}'`,
      `  -H 'X-Zernio-Signature: ${sig}'`,
      `  --data-binary '${body.replace(/'/g, "'\\''")}'`,
    ].join(" \\\n"),
  );
}
