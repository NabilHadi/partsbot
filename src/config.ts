import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  ONEEPC_BASE_URL: z.string().url().default("http://localhost:4010/api/bot/v1"),
  ONEEPC_API_KEY: z.string().min(1),
  // Zernio (WhatsApp). Optional so the worker/mock/tests need none of them; the API only
  // mounts the webhook route when ZERNIO_WEBHOOK_SECRET is set (see main.ts).
  ZERNIO_API_KEY: z.string().min(1).optional(),
  ZERNIO_WEBHOOK_SECRET: z.string().min(16, "use at least 16 characters").optional(),
  /** Zernio accountId of the connected WhatsApp number; events for other accounts are ignored. */
  ZERNIO_ACCOUNT_ID: z.string().min(1).optional(),
  /** Worker only. Default TRUE: the bot logs reply ids/lengths and sends nothing. Only "false", "0" or "no" turn it off. */
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => !["false", "0", "no"].includes((v ?? "").trim().toLowerCase())),
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
