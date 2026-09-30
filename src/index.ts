import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { match } from "./core/matcher.js";
import type { State } from "./core/types.js";
import { makeChatAdminsCache } from "./shell/chat-admins.js";
import { loadInsults } from "./shell/insults.js";
import { makeLlmClient } from "./shell/llm/anthropic.js";
import { invokeChime, makeChimeScheduler } from "./shell/llm/chime.js";
import { makePhotoDescriber } from "./shell/llm/describe-photo.js";
import type { InvokeDigestDeps } from "./shell/llm/digest.js";
import type { InvokeLlmDeps } from "./shell/llm/invoke.js";
import { buildPersonaPrompt, DIGEST_PROMPT, SEARCH_PROMPT } from "./shell/llm/persona.js";
import type { InvokeRosterDeps } from "./shell/llm/roster.js";
import { makePhotoFetcher } from "./shell/llm/telegram-photos.js";
import { createLogger } from "./shell/logger.js";
import { makeChatSettingsStore } from "./shell/storage/chat-settings.js";
import { openDb } from "./shell/storage/db.js";
import { makeIgnoredUsersStore } from "./shell/storage/ignored.js";
import { makeInstructionStore } from "./shell/storage/instructions.js";
import { makeLlmCallStore } from "./shell/storage/llm-calls.js";
import { makeMessageAppender, makeMessageEditor } from "./shell/storage/messages.js";
import { makeOptOutsStore } from "./shell/storage/opt-outs.js";
import { makePhotoCacheStore } from "./shell/storage/photo-cache.js";
import { makePhotoDescriptionStore } from "./shell/storage/photo-descriptions.js";
import { makeRegularsStore } from "./shell/storage/regulars.js";
import { makeDynamicRuleStore } from "./shell/storage/rules.js";
import { makeUsersStore } from "./shell/storage/users.js";
import { executeActions, toMessageInput, withoutPhotos } from "./shell/telegram.js";
import { startTyping } from "./shell/typing.js";

const config = loadConfig();
const log = createLogger(config);

log.info({ env: config.NODE_ENV }, "kytsunia starting");

const db = openDb(config.DB_PATH, log);
const llmCallStore = makeLlmCallStore(db);
const usersStore = makeUsersStore(db);
const regularsStore = makeRegularsStore(db);
const optOutsStore = makeOptOutsStore(db);
const instructionStore = makeInstructionStore(db);
const ignoredUsersStore = makeIgnoredUsersStore(db);
const chatSettings = makeChatSettingsStore(db);
const profileRefreshInProgress = new Set<number>();
const profileRefreshByChatAdminAt = new Map<number, number>();
const chatsOverviewInProgress = { running: false };
const chimeScheduler = makeChimeScheduler({
  dailyCap: config.KYTSUNIA_CHIME_DAILY_CAP,
  minGapMs: config.KYTSUNIA_CHIME_MIN_GAP_MIN * 60_000,
  quietFromHour: config.KYTSUNIA_CHIME_QUIET_FROM,
  quietToHour: config.KYTSUNIA_CHIME_QUIET_TO,
});
log.info({ dbPath: config.DB_PATH }, "database opened");
log.info({ count: regularsStore.list().length }, "regulars loaded");
log.info({ count: optOutsStore.list().length }, "profile opt-outs loaded");
log.info({ count: ignoredUsersStore.listGlobal().length }, "ignored users loaded");

const insults = loadInsults("./data/insults.json", log);
log.info({ count: insults.length }, "insults loaded");

const dynamicRuleStore = makeDynamicRuleStore(db, log);
const appendMessage = makeMessageAppender(db);
const editMessage = makeMessageEditor(db);
const photoCacheStore = makePhotoCacheStore(db);
const photoDescriptionStore = makePhotoDescriptionStore(db);

const llmClient = makeLlmClient(config.ANTHROPIC_API_KEY);

const bot = new Bot(config.BOT_TOKEN);
const photoFetcher = makePhotoFetcher({
  api: bot.api,
  botToken: config.BOT_TOKEN,
  cache: photoCacheStore,
});

const describePhoto = makePhotoDescriber({
  llmClient,
  llmCallStore,
  store: photoDescriptionStore,
  photoFetcher,
  model: config.KYTSUNIA_PHOTO_DESCRIBE_MODEL,
  log,
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

// Персона під модель і характер чату: чат може перемкнути модель або замінити
// характер командою, а технічна частина промпту від цього не залежить.
// Кешуємо за парою, бо текст стабільний, а будується на кожен виклик.
const personaCache = new Map<string, string>();
const personaFor = (model: string, digestModel: string, character: string | null): string => {
  const key = `${model}\u0000${digestModel}\u0000${character ?? ""}`;
  let persona = personaCache.get(key);
  if (persona === undefined) {
    persona = buildPersonaPrompt({
      model,
      ...(character !== null ? { character } : {}),
      digestModel,
      visionEnabled: config.KYTSUNIA_VISION_ENABLED,
      digestEnabled: config.KYTSUNIA_DIGEST_ENABLED,
      searchEnabled: config.KYTSUNIA_SEARCH_ENABLED,
    });
    personaCache.set(key, persona);
  }
  return persona;
};

const invokeLlmDeps: InvokeLlmDeps = {
  llmClient,
  llmCallStore,
  db,
  model: config.LLM_MODEL,
  digestModel: config.KYTSUNIA_DIGEST_MODEL,
  chatSettings,
  persona: personaFor,
  replyMaxTokens: config.KYTSUNIA_REPLY_MAX_TOKENS,
  cacheTtl: config.KYTSUNIA_CACHE_TTL,
  defaultDailyLimit: config.DEFAULT_DAILY_LLM_LIMIT,
  globalDailyCap: config.GLOBAL_DAILY_LLM_CAP,
  recentContextSize: 10,
  regularsStore,
  instructionStore,
  isIgnored: (userId, chatId) => ignoredUsersStore.isIgnored(userId, chatId),
  usernameOf: (userId) => usersStore.usernameOf(userId),
  rng: Math.random,
  log,
  visionEnabled: config.KYTSUNIA_VISION_ENABLED,
  photoFetcher,
  maxPhotosTotal: config.KYTSUNIA_MAX_PHOTOS_TOTAL,
  maxPhotosPerAlbum: config.KYTSUNIA_MAX_PHOTOS_PER_ALBUM,
  albumDebounceMs: config.KYTSUNIA_VISION_ALBUM_DEBOUNCE_MS,
  threadDepth: config.KYTSUNIA_VISION_THREAD_DEPTH,
  describePhoto,
  describeMaxPerReply: config.KYTSUNIA_PHOTO_DESCRIBE_MAX_PER_REPLY,
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
  instructionStore,
  chatSettings,
  regularsStore,
  botUserId,
  photoDescriptions: photoDescriptionStore,
};

const invokeRosterDeps: InvokeRosterDeps = {
  llmClient,
  llmCallStore,
  regularsStore,
  optedOutUserIds: () => new Set(optOutsStore.list()),
  botUserId,
  instructionStore,
  chatSettings,
  model: config.LLM_MODEL,
  digestModel: config.KYTSUNIA_DIGEST_MODEL,
  persona: personaFor,
  defaultDailyLimit: config.DEFAULT_DAILY_LLM_LIMIT,
  globalDailyCap: config.GLOBAL_DAILY_LLM_CAP,
  log,
  startTyping,
  cacheTtl: config.KYTSUNIA_CACHE_TTL,
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

const chatAdminsCache = makeChatAdminsCache(bot.api, log);
// Команди, для яких треба знати адмінів чату. Груба перевірка, точну робить core.
const CHAT_ADMIN_COMMAND_RE = /(К|к)ицюн(я|ю), (не ігноруй|ігноруй|кого ігноруєш|онови профілі)/;

bot.on("message", async (ctx) => {
  const input = toMessageInput(ctx);
  if (!input) return;

  // Хендли: з автора і з того, кому відповіли — щоб знати й тих, хто давно мовчить.
  if (input.senderId) {
    usersStore.upsert({
      userId: input.senderId,
      username: input.senderUsername ?? null,
      firstName: input.senderName || null,
    });
  }
  if (input.replyTo?.authorId) {
    usersStore.upsert({
      userId: input.replyTo.authorId,
      username: input.replyTo.authorUsername ?? null,
      firstName: input.replyTo.authorName || null,
    });
  }

  // Текст ігнорованого лишається в базі, щоб розмова не втрачала людину, а
  // от його фото моделі бачити не треба — посилання на них не зберігаємо.
  appendMessage(
    ignoredUsersStore.isIgnored(input.senderId, input.chatId) ? withoutPhotos(input) : input,
  );

  log.debug(
    {
      /* ... */
    },
    "message received",
  );

  // Адміни чату потрібні лише командам модерації, і лише в групах: один
  // виклик Telegram на чат на десять хвилин у найгіршому разі.
  const chatAdmins =
    input.chatId < 0 && CHAT_ADMIN_COMMAND_RE.test(input.text)
      ? await chatAdminsCache.get(input.chatId)
      : undefined;

  const state: State = {
    dynamic: dynamicRuleStore.list(),
    policy: {
      ...(config.ADMIN_USER_ID !== undefined ? { adminUserId: config.ADMIN_USER_ID } : {}),
      botUserId,
      ...(bot.botInfo.username ? { botUsername: bot.botInfo.username } : {}),
      ...(chatAdmins
        ? { chatAdminUserIds: chatAdmins.admins, chatModeratorUserIds: chatAdmins.moderators }
        : {}),
    },
    optedOutUserIds: new Set(optOutsStore.list()),
    ignoredUserIds: new Set([
      ...ignoredUsersStore.listGlobal().map((u) => u.userId),
      ...ignoredUsersStore.listInChat(input.chatId).map((u) => u.userId),
    ]),
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
        invokeRosterDeps,
        optOutsStore,
        regularsStore,
        ignoredUsersStore,
        instructionStore,
        chatSettings,
        defaultModel: config.LLM_MODEL,
        defaultDigestModel: config.KYTSUNIA_DIGEST_MODEL,
        profileRefresh: {
          db,
          llmClient,
          regularsStore,
          llmCallStore,
          optedOutUserIds: () => new Set(optOutsStore.list()),
          botUserId,
          log,
        },
        profileRefreshOptions: {
          threshold: config.KYTSUNIA_PROFILE_THRESHOLD,
          days: config.KYTSUNIA_PROFILE_DAYS,
          limitMessages: config.KYTSUNIA_PROFILE_LIMIT_MESSAGES,
          model: config.KYTSUNIA_PROFILE_MODEL,
        },
        profileRefreshInProgress,
        profileRefreshByChatAdminAt,
        usersStore,
        chatsOverview: {
          db,
          llmClient,
          llmCallStore,
          model: config.KYTSUNIA_DIGEST_MODEL,
          botUserId,
          log,
        },
        chatsOverviewInProgress,
        chimeDefaultChance: config.KYTSUNIA_CHIME_DEFAULT_CHANCE,
        chimeMaxChance: config.KYTSUNIA_CHIME_MAX_CHANCE,
        digestMaxCount: config.KYTSUNIA_DIGEST_MAX_COUNT,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "action execution failed");
    }
    return;
  }

  // Повідомлення не до Кицюні. У чатах, де їй дозволено влазити, рахуємо його
  // й час від часу даємо моделі шанс сказати слово. Ігнорованих і самого бота
  // не рахуємо, у приватах нема куди влазити.
  if (
    input.chatId < 0 &&
    input.senderId !== botUserId &&
    !state.ignoredUserIds.has(input.senderId) &&
    chimeScheduler.noteMessage(input.chatId, chatSettings.getChimeChance(input.chatId))
  ) {
    const spoke = await invokeChime(ctx, input.chatId, {
      db,
      llmClient,
      llmCallStore,
      chatSettings,
      regularsStore,
      instructionStore,
      model: config.LLM_MODEL,
      digestModel: config.KYTSUNIA_DIGEST_MODEL,
      persona: personaFor,
      cacheTtl: config.KYTSUNIA_CACHE_TTL,
      botUserId,
      botName,
      replyMaxTokens: config.KYTSUNIA_REPLY_MAX_TOKENS,
      globalDailyCap: config.GLOBAL_DAILY_LLM_CAP,
      contextSize: config.KYTSUNIA_CHIME_CONTEXT,
      appendMessage,
      photoDescriptions: photoDescriptionStore,
      now: () => Date.now(),
      log,
    });
    if (spoke) chimeScheduler.noteSpoke(input.chatId);
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
