import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { match } from "./core/matcher.js";
import type { State } from "./core/types.js";
import { loadInsults } from "./shell/insults.js";
import { makeLlmClient } from "./shell/llm/anthropic.js";
import type { InvokeDigestDeps } from "./shell/llm/digest.js";
import type { InvokeLlmDeps } from "./shell/llm/invoke.js";
import { buildPersonaPrompt, DIGEST_PROMPT, SEARCH_PROMPT } from "./shell/llm/persona.js";
import { makePhotoFetcher } from "./shell/llm/telegram-photos.js";
import { createLogger } from "./shell/logger.js";
import { openDb } from "./shell/storage/db.js";
import { makeLlmCallStore } from "./shell/storage/llm-calls.js";
import { makeMessageAppender, makeMessageEditor } from "./shell/storage/messages.js";
import { makeOptOutsStore } from "./shell/storage/opt-outs.js";
import { makePhotoCacheStore } from "./shell/storage/photo-cache.js";
import { makeRegularsStore } from "./shell/storage/regulars.js";
import { makeDynamicRuleStore } from "./shell/storage/rules.js";
import { executeActions, toMessageInput } from "./shell/telegram.js";
import { startTyping } from "./shell/typing.js";

const config = loadConfig();
const log = createLogger(config);

log.info({ env: config.NODE_ENV }, "kytsunia starting");

const db = openDb(config.DB_PATH, log);
const llmCallStore = makeLlmCallStore(db);
const regularsStore = makeRegularsStore(db);
const optOutsStore = makeOptOutsStore(db);
log.info({ dbPath: config.DB_PATH }, "database opened");
log.info({ count: regularsStore.list().length }, "regulars loaded");
log.info({ count: optOutsStore.list().length }, "profile opt-outs loaded");

const insults = loadInsults("./data/insults.json", log);
log.info({ count: insults.length }, "insults loaded");

const dynamicRuleStore = makeDynamicRuleStore(db, log);
const appendMessage = makeMessageAppender(db);
const editMessage = makeMessageEditor(db);
const photoCacheStore = makePhotoCacheStore(db);

const llmClient = makeLlmClient(config.ANTHROPIC_API_KEY);

const bot = new Bot(config.BOT_TOKEN);
const photoFetcher = makePhotoFetcher({
  api: bot.api,
  botToken: config.BOT_TOKEN,
  cache: photoCacheStore,
});

log.info({ model: config.LLM_MODEL }, "llm client ready");

try {
  await bot.init();
} catch (err) {
  if (err instanceof Error && err.message.includes("getMe")) {
    log.error({ msg: err.message }, "bot failed to authenticate, check BOT_TOKEN");
  } else {
    log.error({ err }, "bot init failed");
  }
  db.close();
  process.exit(1);
}

const botUserId = bot.botInfo.id;
const botName = bot.botInfo.first_name ?? "Кицюня";
log.info({ username: bot.botInfo.username, id: botUserId }, "bot info loaded");

const persona = buildPersonaPrompt({
  model: config.LLM_MODEL,
  digestModel: config.KYTSUNIA_DIGEST_MODEL,
  visionEnabled: config.KYTSUNIA_VISION_ENABLED,
  digestEnabled: config.KYTSUNIA_DIGEST_ENABLED,
  searchEnabled: config.KYTSUNIA_SEARCH_ENABLED,
});

const invokeLlmDeps: InvokeLlmDeps = {
  llmClient,
  llmCallStore,
  db,
  model: config.LLM_MODEL,
  persona,
  defaultDailyLimit: config.DEFAULT_DAILY_LLM_LIMIT,
  globalDailyCap: config.GLOBAL_DAILY_LLM_CAP,
  recentContextSize: 10,
  profilesLimit: 5,
  regularsStore,
  rng: Math.random,
  log,
  visionEnabled: config.KYTSUNIA_VISION_ENABLED,
  photoFetcher,
  maxPhotosTotal: config.KYTSUNIA_MAX_PHOTOS_TOTAL,
  maxPhotosPerAlbum: config.KYTSUNIA_MAX_PHOTOS_PER_ALBUM,
  albumDebounceMs: config.KYTSUNIA_VISION_ALBUM_DEBOUNCE_MS,
  threadDepth: config.KYTSUNIA_VISION_THREAD_DEPTH,
  ttlMs: config.KYTSUNIA_VISION_TTL_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  appendMessage,
  botUserId,
  botName,
  startTyping,
  searchEnabled: config.KYTSUNIA_SEARCH_ENABLED,
  searchMaxUses: config.KYTSUNIA_SEARCH_MAX_USES,
  searchWeight: config.KYTSUNIA_SEARCH_WEIGHT,
  searchPrompt: SEARCH_PROMPT,
};

const invokeDigestDeps: InvokeDigestDeps = {
  enabled: config.KYTSUNIA_DIGEST_ENABLED,
  llmClient,
  llmCallStore,
  db,
  model: config.KYTSUNIA_DIGEST_MODEL,
  prompt: DIGEST_PROMPT,
  defaultCount: config.KYTSUNIA_DIGEST_DEFAULT_COUNT,
  maxCount: config.KYTSUNIA_DIGEST_MAX_COUNT,
  weight: config.KYTSUNIA_DIGEST_WEIGHT,
  defaultDailyLimit: config.DEFAULT_DAILY_LLM_LIMIT,
  globalDailyCap: config.GLOBAL_DAILY_LLM_CAP,
  log,
  startTyping,
};

log.info(
  {
    enabled: config.KYTSUNIA_DIGEST_ENABLED,
    model: config.KYTSUNIA_DIGEST_MODEL,
    defaultCount: config.KYTSUNIA_DIGEST_DEFAULT_COUNT,
  },
  "digest configured",
);

log.info(
  {
    enabled: config.KYTSUNIA_SEARCH_ENABLED,
    maxUses: config.KYTSUNIA_SEARCH_MAX_USES,
    weight: config.KYTSUNIA_SEARCH_WEIGHT,
  },
  "web search configured",
);

bot.on("message", async (ctx) => {
  const input = toMessageInput(ctx);
  if (!input) return;

  appendMessage(input);

  log.debug(
    {
      /* ... */
    },
    "message received",
  );

  const state: State = {
    dynamic: dynamicRuleStore.list(),
    policy: {
      ...(config.ADMIN_USER_ID !== undefined ? { adminUserId: config.ADMIN_USER_ID } : {}),
      botUserId,
      ...(bot.botInfo.username ? { botUsername: bot.botInfo.username } : {}),
    },
    optedOutUserIds: new Set(optOutsStore.list()),
  };

  const actions = match(input, state);
  if (actions && actions.length > 0) {
    log.debug({ actions: actions.map((a) => a.kind) }, "actions produced");
    try {
      await executeActions(actions, ctx, {
        insults,
        rng: Math.random,
        dynamicRuleStore,
        llmCallStore,
        defaultDailyLimit: config.DEFAULT_DAILY_LLM_LIMIT,
        invokeLlmDeps,
        invokeDigestDeps,
        optOutsStore,
        regularsStore,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "action execution failed");
    }
  }
});

// Правка тексту чи підпису. Правила заново не проганяємо: відредаговане
// «Кицюня, ...» не має викликати її вдруге. Оновлюємо лише збережений текст,
// щоб контекст і дайджест бачили актуальну версію.
bot.on("edited_message", (ctx) => {
  const m = ctx.editedMessage;
  const text = m.text ?? m.caption;
  if (text === undefined) return;
  const updated = editMessage(m.chat.id, m.message_id, text);
  log.debug({ chatId: m.chat.id, msgId: m.message_id, updated }, "message edited");
});

bot.catch((err) => {
  log.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "bot error");
});

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  bot.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await bot.start({
    onStart: (info) => log.info({ username: info.username, id: info.id }, "bot polling started"),
  });
} catch (err) {
  log.error({ err }, "bot polling failed");
  db.close();
  process.exit(1);
}
