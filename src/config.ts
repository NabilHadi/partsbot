import { z } from "zod";

/** Optional string: blank = null. */
const OPT_STR = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : null));

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
  /**
   * AI layer (src/ai). Global switch, default OFF; each shop must also have config.aiEnabled. Only "true" turns it on.
   * Without a key the AI stays off (the rule engine answers) and /admin/app says so.
   */
  AI_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().toLowerCase() === "true"),
  /** Server-default provider. A shop can override it with its `aiProvider` setting (e.g. the test shop on DeepSeek). */
  AI_PROVIDER: z.enum(["gemini", "deepseek"]).default("gemini"),
  /**
   * Optional cross-provider retry: when set and different from the provider in use, the ONE retry goes to this
   * provider's main model (e.g. DeepSeek first, Gemini Flash-Lite on retry). Unset = retry within the same provider.
   */
  AI_FALLBACK_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .pipe(z.enum(["gemini", "deepseek"]).nullable()),
  /** Per model call; one retry. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000),
  /** Gemini model ids as listed by models.list. GEMINI_FALLBACK_MODEL = model for the same-provider retry. */
  GEMINI_MODEL: z.string().min(1).default("gemini-3.8-flash"),
  GEMINI_FALLBACK_MODEL: OPT_STR,
  /** Never logged or shown; /admin/app only says configured yes/no. */
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** DeepSeek (OpenAI-compatible). Model ids as listed by GET /models; deepseek-flash = DeepSeek-V4.1-Flash. */
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-flash"),
  DEEPSEEK_FALLBACK_MODEL: OPT_STR,
  /** disabled (default: fastest, temperature honoured) | low | high (thinking mode effort). */
  DEEPSEEK_THINKING: z.enum(["disabled", "low", "high"]).default("disabled"),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  /** Never logged or shown. */
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
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
  // Legacy names (before DeepSeek): AI_MODEL / AI_FALLBACK_MODEL were the Gemini models.
  const e = { ...env };
  if (!e.GEMINI_MODEL && e.AI_MODEL) e.GEMINI_MODEL = e.AI_MODEL;
  if (!e.GEMINI_FALLBACK_MODEL && e.AI_FALLBACK_MODEL) e.GEMINI_FALLBACK_MODEL = e.AI_FALLBACK_MODEL;
  const parsed = envSchema.safeParse(e);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
