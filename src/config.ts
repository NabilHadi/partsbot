import { z } from "zod";

const envSchema = z
  .object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  /** The real OneEPC Bot API. Auth: `Authorization: Bearer oeb_...` (key from bot-key.js on the oneepc.com host). */
  ONEEPC_BASE_URL: z.string().url().default("https://oneepc.com/api/bot/v1"),
  /** Real bot key. Optional: without it every "real" endpoint is unavailable (handoff), status shows "not configured". */
  ONEEPC_API_KEY: z.string().min(1).optional(),
  /** Local mock (src/mock/oneepc-mock.ts). Used only by endpoints whose source is "mock", and only for test shops. */
  ONEEPC_MOCK_BASE_URL: z.string().url().optional(),
  ONEEPC_MOCK_API_KEY: z.string().min(1).optional(),
  /** Per-endpoint source. decode and search must match (vehicle_id is opaque per backend). Default real. */
  ONEEPC_DECODE_SOURCE: z.enum(["real", "mock"]).default("real"),
  ONEEPC_SEARCH_SOURCE: z.enum(["real", "mock"]).default("real"),
  // Zernio (WhatsApp). Optional so the worker/mock/tests need none of them; the API only
  // mounts the webhook route when ZERNIO_WEBHOOK_SECRET is set (see main.ts).
  ZERNIO_API_KEY: z.string().min(1).optional(),
  ZERNIO_WEBHOOK_SECRET: z.string().min(16, "use at least 16 characters").optional(),
  /** Zernio accountId of the connected WhatsApp number; events for other accounts are ignored. */
  ZERNIO_ACCOUNT_ID: z.string().min(1).optional(),
  /** Admin web UI (/admin) password, single admin user. Unset = /admin answers 503. Never logged. */
  ADMIN_PASSWORD: z.string().min(1).optional(),
  /** Worker only. Default TRUE: the bot logs reply ids/lengths and sends nothing. Only "false", "0" or "no" turn it off. */
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => !["false", "0", "no"].includes((v ?? "").trim().toLowerCase())),
  /** Lets a TEST shop (shops.config.testShop) see synthetic stock without allowSyntheticStock. Real shops: never. */
  ALLOW_SYNTHETIC_STOCK: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().toLowerCase() === "true"),
  })
  .superRefine((env, ctx) => {
    if (env.ONEEPC_DECODE_SOURCE !== env.ONEEPC_SEARCH_SOURCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ONEEPC_SEARCH_SOURCE"],
        message: "must equal ONEEPC_DECODE_SOURCE (a vehicle_id from one backend is meaningless to the other)",
      });
    }
    const usesMock = env.ONEEPC_DECODE_SOURCE === "mock" || env.ONEEPC_SEARCH_SOURCE === "mock";
    if (usesMock && !env.ONEEPC_MOCK_BASE_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ONEEPC_MOCK_BASE_URL"], message: "required when an endpoint source is mock" });
    }
  });

export type Config = z.infer<typeof envSchema>;

/** Parse and validate environment variables. Throws a readable error if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
