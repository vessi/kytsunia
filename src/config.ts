import { z } from "zod";

// Node's --env-file parses KEY= as { KEY: "" }, not undefined.
// Treat empty string as "absent" so optional/default behave correctly.
const envValue = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

const envSchema = z.object({
  BOT_TOKEN: envValue(z.string().min(1, "BOT_TOKEN is required")),
  ADMIN_USER_ID: envValue(z.coerce.number().int().positive().optional()),
  ANTHROPIC_API_KEY: envValue(z.string().min(1, "ANTHROPIC_API_KEY is required for LLM features")),
  DB_PATH: envValue(z.string().default("./data/kytsunia.db")),
  LOG_LEVEL: envValue(z.enum(["debug", "info", "warn", "error"]).default("info")),
  NODE_ENV: envValue(z.enum(["development", "production", "test"]).default("development")),
  // LLM-настройки
  DEFAULT_DAILY_LLM_LIMIT: envValue(z.coerce.number().int().positive().default(15)),
  GLOBAL_DAILY_LLM_CAP: envValue(z.coerce.number().int().positive().default(150)),
  LLM_MODEL: envValue(z.string().default("claude-haiku-4-5-20251001")),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid configuration:");
    for (const [key, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
      console.error(`  ${key}: ${(errors ?? []).join(", ")}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
