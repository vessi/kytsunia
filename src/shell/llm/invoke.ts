import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages, type RecentMessageRow } from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import type { LlmClient } from "./anthropic.js";
import { buildLlmRequest, type RecentMessage } from "./context.js";
import { calculateCost } from "./pricing.js";
import { collectProfiles } from "./profiles.js";
import type { FetchedPhoto, PhotoFetcher } from "./telegram-photos.js";

export type InvokeLlmDeps = {
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  db: Db;
  model: string;
  persona: string;
  defaultDailyLimit: number;
  globalDailyCap: number;
  recentContextSize: number;
  profilesLimit: number;
  regularsStore: RegularsStore;
  rng: () => number;
  log: Logger;
  // Vision
  visionEnabled: boolean;
  photoFetcher: PhotoFetcher;
  maxPhotosTotal: number;
  maxPhotosPerAlbum: number;
  albumDebounceMs: number;
  sleep: (ms: number) => Promise<void>;
};

const RATE_LIMIT_REPLIES = [
  "Дядя, ти вже мене сьогодні замучив. Завтра.",
  "Усе, на сьогодні досить.",
  "Іди читай книжку, я в режимі економії.",
];

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

/**
 * Фото, на які поточне повідомлення посилається через reply_to.
 *  - Альбом → всі сіблінги з DB.
 *  - Одне фото → беремо file_id прямо з ctx.reply_to_message.
 *  - Reply без фото → порожній масив.
 *
 * НАВМИСНО НЕ підтягуємо «просто з історії»: інакше моделі бачать фото на
 * кожному текстовому реплаї і фіксуються на них (recency-photo-bias).
 */
function collectReplyTargetPhotos(ctx: Context, db: Db): PhotoRef[] {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return [];
  const chatId = ctx.message?.chat.id ?? 0;

  if (reply.media_group_id) {
    return getAlbumPhotoRefs(db, chatId, reply.media_group_id);
  }
  const largest = reply.photo?.at(-1);
  if (largest) {
    return [{ fileId: largest.file_id, uniqueId: largest.file_unique_id }];
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
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;
  const userName = ctx.from?.first_name ?? "";
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";

  const baseRecord = {
    ts: Date.now(),
    chatId,
    userId,
    userName,
    triggerMsgId: replyTo,
    model: deps.model,
  };

  // 1. Global cap
  const globalStatus = deps.llmCallStore.checkGlobalRate(deps.globalDailyCap);
  if (!globalStatus.allowed) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "global_cap" });
    deps.log.warn({ chatId, userId, used: globalStatus.used }, "global llm cap reached");
    await ctx.reply("На сьогодні досить, до завтра.", { reply_to_message_id: replyTo });
    return;
  }

  // 2. User rate
  const userStatus = deps.llmCallStore.checkUserRate(userId, deps.defaultDailyLimit);
  if (!userStatus.allowed) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "user_limit" });
    const idx = Math.floor(deps.rng() * RATE_LIMIT_REPLIES.length);
    const message = RATE_LIMIT_REPLIES[idx] ?? "На сьогодні все.";
    await ctx.reply(message, { reply_to_message_id: replyTo });
    return;
  }

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
  const profiles = collectProfiles(
    deps.regularsStore,
    userId,
    chatId,
    recentRows,
    deps.profilesLimit,
  );

  // 5. Зібрати фото — ТІЛЬКИ ті, на які явно посилаємось:
  //    - trigger (поточне фото або альбом)
  //    - reply target (фото в reply_to_message + сіблінги альбому)
  //    Історичні фото свідомо не підтягуємо — інакше модель фіксується на них
  //    при кожному наступному текстовому реплаї (recency-photo-bias).
  const triggerRaw = deps.visionEnabled ? collectTriggerPhotos(ctx, deps.db) : [];
  const replyRaw = deps.visionEnabled ? collectReplyTargetPhotos(ctx, deps.db) : [];

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

  // Total cap: trigger має пріоритет.
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

  const recent: RecentMessage[] = recentRows.map((row) => ({
    senderName: row.senderName,
    text: row.text,
    photos: [],
  }));

  const { system, userMessage } = buildLlmRequest(
    { senderName: userName, text, photos: currentPhotos },
    recent,
    deps.persona,
    profiles,
  );

  try {
    const reply = await deps.llmClient.reply(system, userMessage, deps.model);
    const cost = calculateCost(deps.model, {
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      cacheReadTokens: reply.cacheReadTokens,
      cacheWriteTokens: reply.cacheWriteTokens,
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
      },
      "llm reply ok",
    );

    await ctx.reply(reply.text, { reply_to_message_id: replyTo });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    deps.llmCallStore.record({ ...baseRecord, status: "error", errorMessage });
    deps.log.error({ err: errorMessage, chatId, userId }, "llm reply failed");
    await ctx.reply("Щось не вийшло, спробуй пізніше.", { reply_to_message_id: replyTo });
  }
}

// Re-export for tests
export type { RecentMessageRow };
