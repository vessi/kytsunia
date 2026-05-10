import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { match } from "./core/matcher.js";
import type { State } from "./core/types.js";
import { loadInsults } from "./shell/insults.js";
import { makeLlmClient } from "./shell/llm/anthropic.js";
import type { InvokeLlmDeps } from "./shell/llm/invoke.js";
import { PERSONA_PROMPT } from "./shell/llm/persona.js";
import { makePhotoFetcher } from "./shell/llm/telegram-photos.js";
import { createLogger } from "./shell/logger.js";
import { openDb } from "./shell/storage/db.js";
import { makeLlmCallStore } from "./shell/storage/llm-calls.js";
import { makeMessageAppender } from "./shell/storage/messages.js";
import { makeOptOutsStore } from "./shell/storage/opt-outs.js";
import { makePhotoCacheStore } from "./shell/storage/photo-cache.js";
import { makeRegularsStore } from "./shell/storage/regulars.js";
import { makeDynamicRuleStore } from "./shell/storage/rules.js";
import { executeActions, toMessageInput } from "./shell/telegram.js";

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

const invokeLlmDeps: InvokeLlmDeps = {
  llmClient,
  llmCallStore,
  db,
  model: config.LLM_MODEL,
  persona: PERSONA_PROMPT,
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
};

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
        optOutsStore,
        regularsStore,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "action execution failed");
    }
  }
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
