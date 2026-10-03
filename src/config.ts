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
  // Sonnet 5, а не Haiku: краща українська, і персона (~2k токенів) кешується —
  // у Haiku 4.5 мінімальний префікс для кешу 4096 токенів, тож там кеш не працює.
  LLM_MODEL: envValue(z.string().default("claude-sonnet-5")),
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
  // Глибина traversal по reply-ланцюгу: і для пошуку фото в треді, і для
  // текстової гілки, яка їде в контекст моделі.
  // Кицюня зберігає свої відповіді — тож chain типу
  //   user(текст) → bot → user(текст) → bot → user(фото)
  // має знайти фото за 4 кроки.
  KYTSUNIA_VISION_THREAD_DEPTH: envValue(z.coerce.number().int().nonnegative().default(5)),
  // Фото з історії йдуть у контекст текстовим описом, а не картинкою. Описи
  // генерує дешева модель, ліниво, з кешем назавжди за unique_id.
  KYTSUNIA_PHOTO_DESCRIBE_MODEL: envValue(z.string().default("claude-haiku-4-5")),
  // Скільки нових описів робити за одну відповідь: обмежує затримку й ціну,
  // коли в чат щойно накидали десяток фото.
  KYTSUNIA_PHOTO_DESCRIBE_MAX_PER_REPLY: envValue(z.coerce.number().int().nonnegative().default(3)),
  // Дайджест: переказ останніх N повідомлень чату.
  KYTSUNIA_DIGEST_ENABLED: envValue(
    z
      .string()
      .default("true")
      .transform((v) => v === "true" || v === "1"),
  ),
  // Скільки повідомлень брати, коли число не назвали явно.
  KYTSUNIA_DIGEST_DEFAULT_COUNT: envValue(z.coerce.number().int().positive().default(300)),
  // Стеля на явно назване число. 500 повідомлень ≈ 20k вхідних токенів.
  // Чат може задати нижчу командою «Кицюня, ліміт дайджесту».
  KYTSUNIA_DIGEST_MAX_COUNT: envValue(z.coerce.number().int().positive().default(500)),
  // Окрема модель: haiku помітно гірше узагальнює довгий тред.
  KYTSUNIA_DIGEST_MODEL: envValue(z.string().default("claude-sonnet-5")),
  // Скільки слотів добового ліміту зʼїдає один дайджест.
  KYTSUNIA_DIGEST_WEIGHT: envValue(z.coerce.number().int().positive().default(3)),
  // Повторні дайджести: якщо є дайджест не старший за REUSE_HOURS, вікно якого
  // перетинається з новим, і непокритих ним повідомлень менше за MIN_NEW —
  // даємо посилання на нього замість нового виклику. Інакше добудовуємо лише
  // непокрите, з текстом попереднього в контексті.
  KYTSUNIA_DIGEST_REUSE_HOURS: envValue(z.coerce.number().nonnegative().default(2)),
  KYTSUNIA_DIGEST_MIN_NEW: envValue(z.coerce.number().int().nonnegative().default(20)),
  // Профілі постійних учасників: скрипт refresh-regulars і «Кицюня, онови профілі».
  KYTSUNIA_PROFILE_MODEL: envValue(z.string().default("claude-sonnet-5")),
  // Мінімум повідомлень за період, щоб отримати профіль.
  KYTSUNIA_PROFILE_THRESHOLD: envValue(z.coerce.number().int().positive().default(30)),
  KYTSUNIA_PROFILE_DAYS: envValue(z.coerce.number().int().positive().default(30)),
  // Скільки останніх повідомлень людини йде в модель.
  KYTSUNIA_PROFILE_LIMIT_MESSAGES: envValue(z.coerce.number().int().positive().default(200)),
  // Не переписувати профіль, якщо з його часу менше за стільки нових повідомлень.
  KYTSUNIA_PROFILE_MIN_NEW: envValue(z.coerce.number().int().nonnegative().default(30)),
  // Влазити в розмову без звернення. Шанс на повідомлення задається на чат
  // командою («Кицюня, влазь 5%»); тут — дефолт для голого «влазь» і стеля,
  // щоб описка не зробила з неї базіку. Далі — не частіше за MIN_GAP, не
  // більше DAILY_CAP реплік на добу, і не в тихі години за Києвом [FROM, TO).
  KYTSUNIA_CHIME_DEFAULT_CHANCE: envValue(z.coerce.number().min(0).max(1).default(0.01)),
  KYTSUNIA_CHIME_MAX_CHANCE: envValue(z.coerce.number().min(0).max(1).default(0.2)),
  KYTSUNIA_CHIME_DAILY_CAP: envValue(z.coerce.number().int().positive().default(5)),
  KYTSUNIA_CHIME_MIN_GAP_MIN: envValue(z.coerce.number().int().nonnegative().default(30)),
  KYTSUNIA_CHIME_QUIET_FROM: envValue(z.coerce.number().int().min(0).max(23).default(23)),
  KYTSUNIA_CHIME_QUIET_TO: envValue(z.coerce.number().int().min(0).max(23).default(8)),
  // Скільки останніх повідомлень модель бачить, вирішуючи, чи влазити.
  KYTSUNIA_CHIME_CONTEXT: envValue(z.coerce.number().int().positive().default(100)),
  // Життя prompt-кешу: 5m або 1h. Година дорожча в записі (2x проти 1.25x), але
  // звернення після паузи в 5–60 хв читають кеш замість писати заново.
  KYTSUNIA_CACHE_TTL: envValue(z.enum(["5m", "1h"]).default("1h")),
  // Бюджет вихідних токенів звичайної відповіді. Модель думає в той самий
  // бюджет, тож 500 на «1-3 речення» вистачало впритул, а довша персона в
  // нього не влазить. Ліміт Telegram на повідомлення обходиться розбиттям.
  KYTSUNIA_REPLY_MAX_TOKENS: envValue(z.coerce.number().int().positive().default(2000)),
  // Пошук в інтернеті на явну команду «Кицюня, пошукай».
  KYTSUNIA_SEARCH_ENABLED: envValue(
    z
      .string()
      .default("true")
      .transform((v) => v === "true" || v === "1"),
  ),
  // Скільки пошуків модель може зробити за одну відповідь. Кожен — $0.01.
  KYTSUNIA_SEARCH_MAX_USES: envValue(z.coerce.number().int().positive().default(3)),
  // Скільки слотів добового ліміту зʼїдає відповідь з пошуком.
  KYTSUNIA_SEARCH_WEIGHT: envValue(z.coerce.number().int().positive().default(3)),
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
