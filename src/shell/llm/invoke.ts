import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { Db } from "../storage/db.js";
import type { InstructionStore } from "../storage/instructions.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import {
  getRecentMessages,
  type MessageAppender,
  type RecentMessageRow,
} from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import type { TypingStarter } from "../typing.js";
import { type LlmClient, type ReplySource, webSearchTool } from "./anthropic.js";
import { buildLlmRequest, type RecentMessage } from "./context.js";
import type { PhotoDescriber } from "./describe-photo.js";
import { withSpecialInstructions } from "./persona.js";
import { calculateCost } from "./pricing.js";
import { collectChatProfiles } from "./profiles.js";
import type { FetchedPhoto, PhotoFetcher } from "./telegram-photos.js";
import { collectThread, replyTargetFromMessage } from "./thread.js";

export type InvokeLlmDeps = {
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  db: Db;
  // Модель за замовчуванням; чат може перевизначити її через chatSettings.
  model: string;
  // Модель дайджесту за замовчуванням: персона чесно каже, хто пише дайджести.
  digestModel: string;
  chatSettings: ChatSettingsStore;
  // Персона залежить від моделей (вона чесно називає, на чому працює) і від
  // чату (адмін може замінити характер), тому будується на кожен виклик.
  persona: (model: string, digestModel: string, character: string | null) => string;
  defaultDailyLimit: number;
  globalDailyCap: number;
  recentContextSize: number;
  regularsStore: RegularsStore;
  // Спеціальні інструкції адміна для чату, дописуються до персони.
  instructionStore: InstructionStore;
  // Ігноровані: їхні фото в базу не пишуться, але ціль відповіді приходить
  // прямо з Telegram — її фото теж не показуємо моделі. Текст лишається.
  isIgnored: (userId: number) => boolean;
  rng: () => number;
  log: Logger;
  // Vision
  visionEnabled: boolean;
  photoFetcher: PhotoFetcher;
  maxPhotosTotal: number;
  maxPhotosPerAlbum: number;
  albumDebounceMs: number;
  threadDepth: number;
  // Описи фото з історії: замість живої картинки модель бачить текст.
  describePhoto: PhotoDescriber;
  // Скільки нових описів генерувати за одну відповідь (кешовані не рахуються).
  describeMaxPerReply: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  // Persistence: зберігаємо власні відповіді Кицюні в DB, щоб reply-chain
  // міг по них пройтися — інакше «user → bot → user» розриває chain.
  appendMessage: MessageAppender;
  botUserId: number;
  botName: string;
  // Поновлює «друкує…», поки йде виклик.
  startTyping: TypingStarter;
  // Явний пошук «Кицюня, пошукай».
  searchEnabled: boolean;
  searchMaxUses: number;
  searchWeight: number;
  searchPrompt: string;
};

export type InvokeLlmOptions = {
  // query порожній, коли шукати треба за повідомленням чи фото, на яке відповіли.
  search?: { query: string };
};

const RATE_LIMIT_REPLIES = [
  "Дядя, ти вже мене сьогодні замучив. Завтра.",
  "Усе, на сьогодні досить.",
  "Іди читай книжку, я в режимі економії.",
];

// З пошуком у бюджет відповіді входять ще й запити до пошуку — 500 може не вистачити.
const SEARCH_MAX_TOKENS = 1024;

// Більше двох посилань у чаті — вже простирадло.
const MAX_SOURCES = 2;

/**
 * Джерела пошуку дописуємо самі, з citations відповіді, а не просимо модель
 * вставляти посилання в текст: так URL не вигадаються.
 */
export function withSources(text: string, sources: readonly ReplySource[]): string {
  if (sources.length === 0) return text;
  const label = sources.length === 1 ? "Джерело:" : "Джерела:";
  return `${text}\n\n${label}\n${sources.map((s) => s.url).join("\n")}`;
}

interface PhotoRefRow {
  msg_id: number;
  photo_file_id: string | null;
  photo_unique_id: string | null;
}

/**
 * Витягує всі photo_file_id+photo_unique_id з альбому в DB, відсортовані за msg_id.
 * Використовується для добору сіблінгів trigger/reply album-у.
 */
function getAlbumPhotoRefs(
  db: Db,
  chatId: number,
  mediaGroupId: string,
): Array<{ fileId: string; uniqueId: string }> {
  const stmt = db.prepare(`
    SELECT msg_id, photo_file_id, photo_unique_id
    FROM messages
    WHERE chat_id = ? AND media_group_id = ? AND photo_file_id IS NOT NULL
    ORDER BY msg_id ASC
  `);
  const rows = stmt.all(chatId, mediaGroupId) as PhotoRefRow[];
  return rows
    .filter((r): r is PhotoRefRow & { photo_file_id: string; photo_unique_id: string } =>
      Boolean(r.photo_file_id && r.photo_unique_id),
    )
    .map((r) => ({ fileId: r.photo_file_id, uniqueId: r.photo_unique_id }));
}

type PhotoRef = { fileId: string; uniqueId: string };

/**
 * Збирає список фото поточного повідомлення.
 *  - Якщо trigger має mediaGroupId → всі сіблінги з DB (після debounce).
 *  - Інакше якщо trigger має одне фото → одне фото з ctx.
 *  - Інакше — порожній масив.
 */
function collectTriggerPhotos(ctx: Context, db: Db): PhotoRef[] {
  const m = ctx.message;
  if (!m) return [];
  const chatId = m.chat.id;

  if (m.media_group_id) {
    return getAlbumPhotoRefs(db, chatId, m.media_group_id);
  }
  const largest = m.photo?.at(-1);
  if (largest) {
    return [{ fileId: largest.file_id, uniqueId: largest.file_unique_id }];
  }
  return [];
}

interface ChainRow {
  reply_to_id: number | null;
  photo_file_id: string | null;
  photo_unique_id: string | null;
  media_group_id: string | null;
}

/**
 * Шукає фото в reply-chain починаючи з повідомлення, на яке тегнули. Якщо в
 * самому reply-таргеті фото немає — йдемо за його reply_to_id, і так далі до
 * maxDepth. Кожне повідомлення Кицюні теж зберігається в DB з reply_to_id, тож
 * chain типу «user(текст) → bot → user(текст) → bot → user(фото)» розплутається.
 *
 * Це і є «памʼять про картинку в треді».
 */
function collectReplyTargetPhotos(ctx: Context, db: Db, maxDepth: number): PhotoRef[] {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return [];
  const chatId = ctx.message?.chat.id ?? 0;

  // Direct check на reply-таргет: фото там може бути в ctx прямо.
  if (reply.media_group_id) {
    const refs = getAlbumPhotoRefs(db, chatId, reply.media_group_id);
    if (refs.length > 0) return refs;
  }
  const direct = reply.photo?.at(-1);
  if (direct) {
    return [{ fileId: direct.file_id, uniqueId: direct.file_unique_id }];
  }

  // Walk: починаємо з reply-таргета в DB, йдемо за reply_to_id поки не знайдемо
  // фото чи не вичерпаємо депт.
  const stmt = db.prepare(`
    SELECT reply_to_id, photo_file_id, photo_unique_id, media_group_id
    FROM messages
    WHERE chat_id = ? AND msg_id = ?
  `);

  let currentMsgId: number | null = reply.message_id;
  for (let depth = 0; depth < maxDepth && currentMsgId !== null; depth++) {
    const row = stmt.get(chatId, currentMsgId) as ChainRow | undefined;
    if (!row) return [];

    if (row.media_group_id) {
      const refs = getAlbumPhotoRefs(db, chatId, row.media_group_id);
      if (refs.length > 0) return refs;
    }
    if (row.photo_file_id && row.photo_unique_id) {
      return [{ fileId: row.photo_file_id, uniqueId: row.photo_unique_id }];
    }
    currentMsgId = row.reply_to_id;
  }
  return [];
}

/**
 * Завантажує фото з Telegram, толерантно до помилок: якщо одне впало (timeout,
 * deleted, etc.) — повертаємо null на його позиції, не валимо весь reply.
 */
async function fetchPhotosTolerant(
  refs: PhotoRef[],
  fetcher: PhotoFetcher,
  log: Logger,
): Promise<Array<FetchedPhoto | null>> {
  return Promise.all(
    refs.map(async (r) => {
      try {
        return await fetcher(r.fileId, r.uniqueId);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err, uniqueId: r.uniqueId },
          "photo fetch failed; skipping",
        );
        return null;
      }
    }),
  );
}

export async function invokeLlmReply(
  ctx: Context,
  replyTo: number,
  deps: InvokeLlmDeps,
  options: InvokeLlmOptions = {},
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;
  const userName = ctx.from?.first_name ?? "";
  // Обидві моделі чат може перевизначити окремо; персона чесно називає обидві.
  const model = deps.chatSettings.getModel(chatId) ?? deps.model;
  const digestModel = deps.chatSettings.getDigestModel(chatId) ?? deps.digestModel;
  const search = options.search;
  // При пошуку у відповідь на повідомлення сам тригер — просто «Кицюня, пошукай»,
  // а що шукати, лежить у query. Тому текст для моделі складаємо явно.
  const text = search?.query
    ? `Кицюня, пошукай: ${search.query}`
    : (ctx.message?.text ?? ctx.message?.caption ?? "");
  // Відповідь з пошуком дорожча за звичайну, тож і в лімітах важить більше.
  const weight = search ? deps.searchWeight : 1;

  if (search && !deps.searchEnabled) {
    await ctx.reply("Пошук зараз вимкнений.", { reply_to_message_id: replyTo });
    return;
  }

  const baseRecord = {
    ts: Date.now(),
    chatId,
    userId,
    userName,
    triggerMsgId: replyTo,
    model,
    weight,
  };

  // 1. Global cap. Перевіряємо запас на weight слотів, а не «чи лишився хоч один».
  const globalStatus = deps.llmCallStore.checkGlobalRate(deps.globalDailyCap);
  if (!globalStatus.allowed || globalStatus.cap - globalStatus.used < weight) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "global_cap" });
    deps.log.warn({ chatId, userId, used: globalStatus.used }, "global llm cap reached");
    await ctx.reply("На сьогодні досить, до завтра.", { reply_to_message_id: replyTo });
    return;
  }

  // 2. User rate
  const userStatus = deps.llmCallStore.checkUserRate(userId, deps.defaultDailyLimit);
  const userShort = userStatus.limit !== null && userStatus.limit - userStatus.used < weight;
  if (!userStatus.allowed || userShort) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "user_limit" });
    // Слоти ще є, але на пошук не вистачає — кажемо прямо: «замучив» після
    // пари повідомлень звучало б дивно.
    if (userStatus.allowed) {
      await ctx.reply(`Пошук коштує ${weight} звичайних відповідей, а в тебе стільки нема.`, {
        reply_to_message_id: replyTo,
      });
      return;
    }
    const idx = Math.floor(deps.rng() * RATE_LIMIT_REPLIES.length);
    const message = RATE_LIMIT_REPLIES[idx] ?? "На сьогодні все.";
    await ctx.reply(message, { reply_to_message_id: replyTo });
    return;
  }

  // «Друкує…» вмикаємо, коли вже ясно, що кличемо модель (ліміти пройдено).
  const stopTyping = deps.startTyping(ctx);
  try {
    // 3. Vision: debounce, якщо є альбом, щоб сіблінги встигли в DB.
    const triggerMediaGroupId = ctx.message?.media_group_id;
    const replyMediaGroupId = ctx.message?.reply_to_message?.media_group_id;
    const hasAlbum = Boolean(triggerMediaGroupId || replyMediaGroupId);
    if (deps.visionEnabled && hasAlbum) {
      deps.log.debug(
        { triggerMediaGroupId, replyMediaGroupId, ms: deps.albumDebounceMs },
        "album debounce",
      );
      await deps.sleep(deps.albumDebounceMs);
    }

    // 4. Зібрати recent context (логічні повідомлення з альбомами вже згрупованими).
    const recentRows = getRecentMessages(deps.db, chatId, deps.recentContextSize, replyTo);
    // Усі профілі чату, не лише авторів останніх повідомлень: інакше «що
    // думаєш про Олю?» приходить без Олі, щойно вона хвилину помовчала.
    const profiles = collectChatProfiles(deps.regularsStore, chatId, deps.botUserId);
    // Гілка, на яку відповідають: без неї «а чому саме так?» у reply на давню
    // репліку приходить до моделі без самої репліки.
    const replyMessage = ctx.message?.reply_to_message;
    const replyFromIgnored =
      replyMessage?.from !== undefined && deps.isIgnored(replyMessage.from.id);
    const thread = replyMessage
      ? collectThread(deps.db, chatId, replyTargetFromMessage(replyMessage), deps.threadDepth)
      : [];

    // 5. Зібрати фото — ТІЛЬКИ ті, на які явно посилаємось:
    //    - trigger (поточне фото або альбом)
    //    - reply chain (reply_to_message → ... → знайдене фото)
    //    Фото з історії живими не йдуть ніколи: тільки текстовим описом у
    //    рядку автора. Жива картинка перетягувала увагу моделі на себе на всі
    //    відповіді, поки не вийде з вікна.
    const triggerRaw = deps.visionEnabled ? collectTriggerPhotos(ctx, deps.db) : [];
    const replyRaw =
      deps.visionEnabled && !replyFromIgnored
        ? collectReplyTargetPhotos(ctx, deps.db, deps.threadDepth)
        : [];

    // Per-album cap до кожного джерела окремо.
    const triggerPhotoRefs = triggerRaw.slice(0, deps.maxPhotosPerAlbum);
    if (triggerRaw.length > triggerPhotoRefs.length) {
      deps.log.debug(
        { had: triggerRaw.length, capped: deps.maxPhotosPerAlbum },
        "trigger album exceeds per-album cap",
      );
    }
    const triggerUniqueIds = new Set(triggerPhotoRefs.map((p) => p.uniqueId));
    const replyDeduped = replyRaw.filter((p) => !triggerUniqueIds.has(p.uniqueId));
    const replyPhotoRefs = replyDeduped.slice(0, deps.maxPhotosPerAlbum);

    // Total cap: trigger > reply chain.
    const allRefs = [...triggerPhotoRefs, ...replyPhotoRefs].slice(0, deps.maxPhotosTotal);

    // 6. Завантаження байтів (паралельно, толерантно).
    const fetched = await fetchPhotosTolerant(allRefs, deps.photoFetcher, deps.log);

    // 7. Всі фото йдуть як attachments поточного повідомлення. Для моделі це
    //    «фото, які стосуються цього питання» — і trigger, і reply-target
    //    логічно належать до того, на що користувач зараз дивиться.
    //    Recent історія не несе фото-блоків, тільки текст.
    const currentPhotos = fetched
      .filter((p): p is FetchedPhoto => p !== null)
      .map((f) => ({ mime: f.mime, base64: f.base64 }));

    // 8. Історія — текстом. Фото в ній замінюємо описами: кешовані безкоштовно,
    //    нових за одну відповідь не більше describeMaxPerReply, від найновіших.
    //    Фото, які вже йдуть живими (тригер, гілка), описувати не треба.
    const liveUniqueIds = new Set(allRefs.map((p) => p.uniqueId));
    const describeCtx = { chatId, userId, userName };
    let describeBudget = deps.visionEnabled ? deps.describeMaxPerReply : 0;
    const notesByRow = new Map<number, string[]>();
    for (let i = recentRows.length - 1; i >= 0; i--) {
      const row = recentRows[i];
      if (!row) continue;
      const notes: string[] = [];
      for (const photo of row.photos.slice(0, deps.maxPhotosPerAlbum)) {
        if (liveUniqueIds.has(photo.uniqueId)) continue;
        const described = await deps.describePhoto(photo, describeCtx, {
          allowGenerate: describeBudget > 0,
        });
        if (described?.generated) describeBudget -= 1;
        if (described) notes.push(described.text);
      }
      notesByRow.set(i, notes);
    }
    const recent: RecentMessage[] = recentRows.map((row, i) => ({
      senderName: row.senderName,
      text: row.text,
      photos: [],
      photoNotes: notesByRow.get(i) ?? [],
      photoCount: row.photos.length,
    }));

    // Інструкції адміна й пошуку дописуємо в кінець персони, а не окремим
    // блоком: так вони потрапляють у той самий кешований префікс.
    const base = withSpecialInstructions(
      deps.persona(model, digestModel, deps.chatSettings.getPersona(chatId)),
      deps.instructionStore.list(chatId).map((i) => i.text),
    );
    const persona = search ? `${base}\n\n${deps.searchPrompt}` : base;
    const { system, userMessage } = buildLlmRequest(
      { senderName: userName, text, photos: currentPhotos },
      recent,
      persona,
      profiles,
      thread,
      deps.now(),
    );

    try {
      const reply = search
        ? await deps.llmClient.reply(system, userMessage, model, SEARCH_MAX_TOKENS, {
            tools: [webSearchTool(deps.searchMaxUses)],
          })
        : await deps.llmClient.reply(system, userMessage, model);
      const cost = calculateCost(model, {
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        webSearchRequests: reply.webSearchRequests ?? 0,
      });

      deps.llmCallStore.record({
        ...baseRecord,
        status: "ok",
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        ...(cost !== null ? { costUsd: cost } : {}),
      });

      deps.log.debug(
        {
          chatId,
          userId,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cost,
          photosSent: currentPhotos.length,
          searches: reply.webSearchRequests ?? 0,
        },
        "llm reply ok",
      );

      if (reply.stopReason === "pause_turn" || reply.stopReason === "max_tokens") {
        deps.log.warn({ chatId, userId, stopReason: reply.stopReason }, "llm reply cut short");
      }

      // Порожній текст буває, коли модель вичерпала бюджет або сервер зупинив цикл
      // пошуку (pause_turn) до фінальної відповіді. На порожньому Telegram впаде.
      // Fable ще й відмовляє класифікатором (refusal): тоді це не «загубила».
      const replyText =
        reply.text.trim() ||
        (reply.stopReason === "refusal"
          ? "Про це не буду."
          : search
            ? "Нічого путнього не знайшла."
            : "Загубила думку, спитай ще раз.");
      const sources = search ? (reply.sources ?? []).slice(0, MAX_SOURCES) : [];
      const sent = await ctx.reply(withSources(replyText, sources), {
        reply_to_message_id: replyTo,
        ...(sources.length > 0 ? { link_preview_options: { is_disabled: true } } : {}),
      });
      // Зберігаємо власну відповідь — без цього reply-chain «user → bot → user»
      // не зможе пройтися назад до фото.
      try {
        deps.appendMessage({
          chatId,
          messageId: sent.message_id,
          ts: sent.date * 1000,
          senderId: deps.botUserId,
          senderName: deps.botName,
          text: replyText,
          kind: "text",
          replyTo: { messageId: replyTo, authorId: userId, authorName: userName },
        });
      } catch (persistErr) {
        // Не валимо UX через помилку запису — просто логуємо.
        deps.log.warn(
          { err: persistErr instanceof Error ? persistErr.message : persistErr },
          "failed to persist bot reply",
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.llmCallStore.record({ ...baseRecord, status: "error", errorMessage });
      deps.log.error({ err: errorMessage, chatId, userId }, "llm reply failed");
      await ctx.reply("Щось не вийшло, спробуй пізніше.", { reply_to_message_id: replyTo });
    }
  } finally {
    stopTyping();
  }
}

// Re-export for tests
export type { RecentMessageRow };
