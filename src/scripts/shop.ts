// Shop admin CLI: configure shops without SQL. Every change is validated with the shop-config schema.
//   npm run shop -- list
//   npm run shop -- show <shop-id>
//   npm run shop -- create --name "<name>" [--city <city>] [--zernio-account <id>] [--waba <id>] [--plan starter] [--test]
//   npm run shop -- set <shop-id> key=value [key=value ...] [--dry-run]
//        e.g. showPartNumbers=false stockDisplay=availability showAlternatives=true priceQuotingEnabled=false
//             language=ar afterHoursMode=note_only "hours.fri=08:00-12:00,16:00-23:00" hours.sat=closed
//   npm run shop -- unset <shop-id> key [key ...]            (back to the default; "hours" resets all days)
//   npm run shop -- status <shop-id> active|paused|closed
//   npm run shop -- staff-add <shop-id> --name "<name>" [--no-notify]
//        the number is read from stdin (e.g. `printf '05XXXXXXXX' | npm run shop -- staff-add ...`) or typed at the
//        prompt; never a command-line argument (argv is visible in `ps` and shell history).
//   npm run shop -- staff-remove <shop-id> --name "<name>"
// Staff numbers are stored as normalized E.164 and only ever printed masked (last 4 digits).
import { parseArgs } from "node:util";
import { addStaff, AdminInputError, applySet, applyUnset, parseAssignments, removeStaff, renderConfig, type RawConfig } from "../admin/shop-admin.js";
import { createInterface } from "node:readline/promises";
import { shopConfigSchema } from "../bot/shop-config.js";
import { createPool, type Db } from "../db/pool.js";

const USAGE = `usage: npm run shop -- list | show <id> | create --name <n> [...] | set <id> key=value... [--dry-run] | unset <id> key... | status <id> <active|paused|closed> | staff-add <id> --name <n> (number via stdin/prompt) | staff-remove <id> --name <n>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    city: { type: "string" },
    "zernio-account": { type: "string" },
    waba: { type: "string" },
    plan: { type: "string" },
    test: { type: "boolean", default: false },
    phone: { type: "string" }, // rejected below: numbers never go on the command line
    "no-notify": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(msg: string, code = 2): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(code);
}

if (values.phone !== undefined) fail("--phone is not accepted: pipe the number on stdin or type it at the prompt (argv is visible in ps and shell history)");

const [cmd, id, ...rest] = positionals;
if (!cmd) fail("missing command");
if (cmd !== "list" && cmd !== "create" && !(id && /^[0-9a-f-]{36}$/i.test(id))) fail("missing or invalid <shop-id> (a uuid; see: npm run shop -- list)");

/** The staff number from stdin (piped) or an interactive prompt. Never echoed back. */
async function readPhone(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
      return (await rl.question("WhatsApp number (05XXXXXXXX or +E164): ")).trim();
    } finally {
      rl.close();
    }
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

interface ShopRow { id: string; name: string; city: string | null; zernio_account_id: string | null; waba_id: string | null; plan: string; status: string; config: RawConfig; updated_at: Date }

async function load(db: Db, shopId: string, lock = false): Promise<ShopRow> {
  const r = await db.query<ShopRow>(`SELECT * FROM shops WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [shopId]);
  if (!r.rows[0]) throw new AdminInputError("shop not found");
  return r.rows[0];
}

function printShop(row: ShopRow): void {
  const parsed = shopConfigSchema.safeParse(row.config ?? {});
  console.log(`${row.name}  (${row.id})`);
  console.log(`  city: ${row.city ?? "-"}  plan: ${row.plan}  status: ${row.status}  whatsapp account: ${row.zernio_account_id ? "linked" : "not linked"}`);
  if (!parsed.success) {
    console.log(`  CONFIG INVALID (the bot will not reply for this shop): ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
    return;
  }
  for (const l of renderConfig(row.config ?? {}, parsed.data)) console.log(`  ${l}`);
}

/** Load, change, validate and save in one transaction (two admins cannot overwrite each other). */
async function update(db: Db, shopId: string, change: (raw: RawConfig) => { raw: RawConfig }): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<ShopRow>("SELECT * FROM shops WHERE id = $1 FOR UPDATE", [shopId]);
    const row = r.rows[0];
    if (!row) throw new AdminInputError("shop not found");
    const { raw } = change(row.config ?? {});
    if (values["dry-run"]) {
      await client.query("ROLLBACK");
      console.log("dry run, nothing saved. Result would be:");
      printShop({ ...row, config: raw });
      return;
    }
    const saved = await client.query<ShopRow>("UPDATE shops SET config = $2, updated_at = now() WHERE id = $1 RETURNING *", [shopId, raw]);
    await client.query("COMMIT");
    console.log("saved.");
    printShop(saved.rows[0] as ShopRow);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const db = createPool(process.env.DATABASE_URL ?? fail("DATABASE_URL is not set"));
try {
  switch (cmd) {
    case "list": {
      const r = await db.query<ShopRow>("SELECT * FROM shops ORDER BY created_at");
      if (r.rows.length === 0) console.log("no shops");
      for (const s of r.rows) {
        const ok = shopConfigSchema.safeParse(s.config ?? {});
        const flags = ok.success ? [ok.data.testShop ? "test" : null, ok.data.showPartNumbers ? null : "numbers-hidden", `stock:${ok.data.stockDisplay}`, ok.data.priceQuotingEnabled ? "prices" : null].filter(Boolean).join(" ") : "CONFIG INVALID";
        console.log(`${s.id}  ${s.status.padEnd(6)}  ${s.name}${s.city ? ` (${s.city})` : ""}  [${flags}]`);
      }
      break;
    }
    case "show":
      printShop(await load(db, id as string));
      break;
    case "create": {
      if (!values.name?.trim()) fail("missing --name");
      const config = values.test ? { testShop: true, aiEnabled: true } : {}; // AI: on for test shops, off for real ones until switched on
      const r = await db.query<ShopRow>(
        "INSERT INTO shops (name, city, zernio_account_id, waba_id, plan, config) VALUES ($1, $2, $3, $4, COALESCE($5, 'starter'), $6) RETURNING *",
        [values.name.trim(), values.city ?? null, values["zernio-account"] ?? null, values.waba ?? null, values.plan ?? null, config],
      );
      console.log("created.");
      printShop(r.rows[0] as ShopRow);
      break;
    }
    case "set": {
      const edits = parseAssignments(rest);
      await update(db, id as string, (raw) => applySet(raw, edits));
      break;
    }
    case "unset":
      if (rest.length === 0) fail("nothing to unset");
      await update(db, id as string, (raw) => applyUnset(raw, rest));
      break;
    case "status": {
      const status = rest[0];
      if (!status || !["active", "paused", "closed"].includes(status)) fail("status must be active, paused or closed");
      const r = await db.query("UPDATE shops SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
      if (r.rowCount === 0) throw new AdminInputError("shop not found");
      console.log(`status: ${status}`);
      break;
    }
    case "staff-add": {
      if (!values.name) fail("staff-add needs --name");
      const phone = await readPhone();
      if (!phone) fail("no phone number given (pipe it on stdin or type it at the prompt)");
      await update(db, id as string, (raw) => addStaff(raw, { name: values.name as string, phone, notify: !values["no-notify"] }));
      break;
    }
    case "staff-remove":
      if (!values.name) fail("staff-remove needs --name");
      await update(db, id as string, (raw) => removeStaff(raw, values.name as string));
      break;
    default:
      fail(`unknown command "${cmd}"`);
  }
} catch (err) {
  if (err instanceof AdminInputError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    // Never print the error object (a pg error can echo parameters); name + code only.
    const e = err as { name?: string; code?: string };
    console.error(`shop command failed: ${e.name ?? "Error"}${e.code ? ` (${e.code})` : ""}`);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
