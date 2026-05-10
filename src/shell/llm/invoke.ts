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

  // 5. Зібрати фото:
  //    - trigger (поточне) — пріоритет, не обрізається історією
  //    - history — fill remaining slots; обрізається до maxPhotosTotal
  let triggerPhotoRefs = deps.visionEnabled ? collectTriggerPhotos(ctx, deps.db) : [];
  // Альбом може бути довший за per-album cap — обрізаємо trigger.
  if (triggerPhotoRefs.length > deps.maxPhotosPerAlbum) {
    deps.log.debug(
      { had: triggerPhotoRefs.length, capped: deps.maxPhotosPerAlbum },
      "trigger album exceeds per-album cap",
    );
    triggerPhotoRefs = triggerPhotoRefs.slice(0, deps.maxPhotosPerAlbum);
  }
  // Якщо trigger один сам по собі вже >= total cap → жорстко обрізаємо
  if (triggerPhotoRefs.length > deps.maxPhotosTotal) {
    triggerPhotoRefs = triggerPhotoRefs.slice(0, deps.maxPhotosTotal);
  }

  // History photos (з recentRows) — кожен RecentMessageRow має .photos[].
  // Recent повертається в хронологічному порядку (oldest first), тож для
  // recency-priority при fill ми йдемо з кінця.
  const remainingSlots = deps.visionEnabled
    ? Math.max(0, deps.maxPhotosTotal - triggerPhotoRefs.length)
    : 0;

  // Збираємо history photos з пріоритетом «новіші виграють».
  const historyPhotosNewestFirst: Array<PhotoRef & { rowIdx: number }> = [];
  for (let i = recentRows.length - 1; i >= 0; i--) {
    const row = recentRows[i];
    if (!row) continue;
    let added = 0;
    for (const p of row.photos) {
      if (historyPhotosNewestFirst.length >= remainingSlots) break;
      if (added >= deps.maxPhotosPerAlbum) break;
      historyPhotosNewestFirst.push({ fileId: p.fileId, uniqueId: p.uniqueId, rowIdx: i });
      added++;
    }
    if (historyPhotosNewestFirst.length >= remainingSlots) break;
  }
  // Дедуплікуємо: якщо trigger photo вже в історії (rare), не качаємо двічі.
  const triggerUniqueIds = new Set(triggerPhotoRefs.map((p) => p.uniqueId));
  const historyFiltered = historyPhotosNewestFirst.filter((p) => !triggerUniqueIds.has(p.uniqueId));

  // 6. Завантаження байтів (паралельно, толерантно).
  const [triggerFetched, historyFetched] = await Promise.all([
    fetchPhotosTolerant(triggerPhotoRefs, deps.photoFetcher, deps.log),
    fetchPhotosTolerant(
      historyFiltered.map((p) => ({ fileId: p.fileId, uniqueId: p.uniqueId })),
      deps.photoFetcher,
      deps.log,
    ),
  ]);

  // 7. Збираємо RecentMessage[] для buildLlmRequest, проставляючи завантажені фото
  //    в правильні рядки.
  const fetchedByRowIdx = new Map<number, FetchedPhoto[]>();
  for (let i = 0; i < historyFiltered.length; i++) {
    const ref = historyFiltered[i];
    const got = historyFetched[i];
    if (!ref || !got) continue;
    const arr = fetchedByRowIdx.get(ref.rowIdx);
    if (arr) arr.push(got);
    else fetchedByRowIdx.set(ref.rowIdx, [got]);
  }

  const recent: RecentMessage[] = recentRows.map((row, idx) => {
    const photos = (fetchedByRowIdx.get(idx) ?? []).map((f) => ({
      mime: f.mime,
      base64: f.base64,
    }));
    return { senderName: row.senderName, text: row.text, photos };
  });

  const currentPhotos = triggerFetched
    .filter((p): p is FetchedPhoto => p !== null)
    .map((f) => ({ mime: f.mime, base64: f.base64 }));

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
        photosSent: currentPhotos.length + recent.reduce((a, r) => a + (r.photos?.length ?? 0), 0),
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
