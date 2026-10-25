import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  ONEEPC_BASE_URL: z.string().url().default("http://localhost:4010/api/bot/v1"),
  ONEEPC_API_KEY: z.string().min(1),
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
