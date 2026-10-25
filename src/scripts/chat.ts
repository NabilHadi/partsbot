// Local chat with the bot against the mock OneEPC. No database, no WhatsApp, no network except the in-process mock.
// Usage: npm run chat            (type a customer message, Enter; empty line or Ctrl-D quits)
// Try the fake VINs from the README (TESTLC20220000001 ...). Replies are what DRY_RUN would send.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AddressInfo } from "node:net";
import { buildMockServer, BASE_PATH } from "../mock/oneepc-mock.js";
import { OneEpcClient } from "../oneepc/index.js";
import { Conversation } from "../bot/conversation-driver.js";

const mock = buildMockServer({ apiKey: "chat-key" });
await mock.listen({ port: 0, host: "127.0.0.1" });
const client = new OneEpcClient({
  baseUrl: `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}${BASE_PATH}`,
  apiKey: "chat-key",
});
const convo = new Conversation(client);
const rl = createInterface({ input: stdin, output: stdout });
console.log("PartsBot local chat (mock catalogue, nothing is sent anywhere). Empty line to quit.");
for (;;) {
  const line = (await rl.question("customer> ").catch(() => "")).trim();
  if (!line) break;
  const r = await convo.say(line);
  console.log(r.replies.length ? r.replies.map((x) => `bot> ${x.replace(/\n/g, "\nbot> ")}`).join("\n") : "bot> (silent)");
  for (const a of r.actions) if (a.type !== "oneepc_call") console.log(`     [action] ${JSON.stringify(a)}`);
}
rl.close();
await mock.close();
