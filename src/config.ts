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
  // Vision (фото у відповідях). Фіче-флаг — щоб можна було вимкнути без релізу.
  KYTSUNIA_VISION_ENABLED: envValue(
    z
      .string()
      .default("true")
      .transform((v) => v === "true" || v === "1"),
  ),
  // Жорсткий cap на кількість фото в одному запиті до моделі.
  // ~1.5k токенів на фото; 8 фото ≈ +12k input tokens на reply.
  KYTSUNIA_MAX_PHOTOS_TOTAL: envValue(z.coerce.number().int().positive().default(8)),
  // Cap на один альбом у контексті — щоб великий альбом не зʼїв весь бюджет.
  KYTSUNIA_MAX_PHOTOS_PER_ALBUM: envValue(z.coerce.number().int().positive().default(5)),
  // Затримка перед збором сіблінгів альбому. Telegram шле фото окремими update-ами,
  // потрібен час, щоб всі дійшли в DB.
  KYTSUNIA_VISION_ALBUM_DEBOUNCE_MS: envValue(z.coerce.number().int().nonnegative().default(1500)),
  // Глибина traversal по reply-ланцюгу для пошуку фото в треді.
  // Кицюня зберігає свої відповіді — тож chain типу
  //   user(текст) → bot → user(текст) → bot → user(фото)
  // має знайти фото за 4 кроки.
  KYTSUNIA_VISION_THREAD_DEPTH: envValue(z.coerce.number().int().nonnegative().default(5)),
  // Fallback: якщо ні trigger, ні chain не дали фото — беремо останнє фото в чаті
  // за останні N мс. Покриває «постив фото, тегаю Кицюню без reply».
  // Короткий TTL щоб не повертатись до recency-bias.
  KYTSUNIA_VISION_TTL_MS: envValue(z.coerce.number().int().nonnegative().default(120_000)),
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
