import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import {
  getRecentMessages,
  type MessageAppender,
  type RecentMessageRow,
} from "../storage/messages.js";
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
  threadDepth: number;
  ttlMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  // Persistence: зберігаємо власні відповіді Кицюні в DB, щоб reply-chain
  // міг по них пройтися — інакше «user → bot → user» розриває chain.
  appendMessage: MessageAppender;
  botUserId: number;
  botName: string;
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
 * Останнє фото в чаті за останні ttlMs мілісекунд. Запасний канал, коли тригер
 * без фото, без reply, але хтось щойно постив фото і користувач явно говорить
 * саме про нього («@kytsynia що це?»). Короткий TTL — захист від recency-bias.
 */
function collectRecentPhotoFallback(
  db: Db,
  chatId: number,
  ttlMs: number,
  now: number,
): PhotoRef[] {
  if (ttlMs <= 0) return [];
  const since = now - ttlMs;
  const stmt = db.prepare(`
    SELECT msg_id, photo_file_id, photo_unique_id, media_group_id
    FROM messages
    WHERE chat_id = ? AND ts >= ? AND photo_file_id IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `);
  const row = stmt.get(chatId, since) as
    | {
        msg_id: number;
        photo_file_id: string;
        photo_unique_id: string;
        media_group_id: string | null;
      }
    | undefined;
  if (!row) return [];
  if (row.media_group_id) {
    return getAlbumPhotoRefs(db, chatId, row.media_group_id);
  }
  return [{ fileId: row.photo_file_id, uniqueId: row.photo_unique_id }];
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
  //    - reply chain (reply_to_message → ... → знайдене фото)
  //    - TTL fallback: останнє фото в чаті за N секунд, якщо нічого вище не знайшли
  //    Історичні фото поза цими каналами НЕ підтягуються (recency-photo-bias).
  const triggerRaw = deps.visionEnabled ? collectTriggerPhotos(ctx, deps.db) : [];
  const replyRaw = deps.visionEnabled
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

  // TTL fallback тільки коли нічого не знайдено в попередніх каналах.
  let fallbackRefs: PhotoRef[] = [];
  if (deps.visionEnabled && triggerPhotoRefs.length === 0 && replyPhotoRefs.length === 0) {
    const raw = collectRecentPhotoFallback(deps.db, chatId, deps.ttlMs, deps.now());
    fallbackRefs = raw.slice(0, deps.maxPhotosPerAlbum);
    if (fallbackRefs.length > 0) {
      deps.log.debug({ count: fallbackRefs.length, ttlMs: deps.ttlMs }, "vision: TTL fallback hit");
    }
  }

  // Total cap: trigger > reply chain > TTL fallback.
  const allRefs = [...triggerPhotoRefs, ...replyPhotoRefs, ...fallbackRefs].slice(
    0,
    deps.maxPhotosTotal,
  );

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

    const sent = await ctx.reply(reply.text, { reply_to_message_id: replyTo });
    // Зберігаємо власну відповідь — без цього reply-chain «user → bot → user»
    // не зможе пройтися назад до фото.
    try {
      deps.appendMessage({
        chatId,
        messageId: sent.message_id,
        ts: sent.date * 1000,
        senderId: deps.botUserId,
        senderName: deps.botName,
        text: reply.text,
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
}

// Re-export for tests
export type { RecentMessageRow };
