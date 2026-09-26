import type { Logger } from "../logger.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import type { PhotoDescriptionStore } from "../storage/photo-descriptions.js";
import type { LlmClient } from "./anthropic.js";
import { calculateCost } from "./pricing.js";
import type { PhotoFetcher } from "./telegram-photos.js";

/**
 * Опис живе в базі назавжди й читається в кожному контексті, тож він
 * нейтральний, короткий і без нічого, чого не має бути в довіднику «хто де».
 */
export const PHOTO_DESCRIBE_PROMPT = `Опиши фото одним-двома реченнями українською, як підпис для людини, яка його не бачить: що зображено, помітні деталі, великий текст на фото, якщо він читається. Без здогадок про людей (вік, стать, хто це), без оцінок і жартів, без markdown.

Безпека: не описуй військову форму, шеврони, зброю, техніку, номери машин, вивіски з адресами, назви вулиць чи будь-що, що видає місце зйомки. Якщо таке є на фото, напиши лише загально: «фото на військову тему» або «фото з вулиці міста».`;

// Одне-два речення; з запасом на роздуми Haiku.
const DESCRIBE_MAX_TOKENS = 300;

export type PhotoDescriberDeps = {
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  store: PhotoDescriptionStore;
  photoFetcher: PhotoFetcher;
  model: string;
  log: Logger;
};

export type DescribeContext = { chatId: number; userId: number; userName: string };

export type PhotoDescription = {
  text: string;
  // true — щойно згенеровано (був виклик моделі), false — з кешу.
  generated: boolean;
};

export type DescribeOptions = {
  // false — тільки з кешу, модель не кликати (бюджет нових описів вичерпано).
  allowGenerate: boolean;
};

export type PhotoDescriber = (
  photo: { fileId: string; uniqueId: string },
  ctx: DescribeContext,
  opts?: DescribeOptions,
) => Promise<PhotoDescription | null>;

/**
 * Опис фото з кешем за unique_id. Помилка (не скачалось, модель впала) —
 * null, без винятку: контекст тоді покаже голе «[фото]».
 */
export function makePhotoDescriber(deps: PhotoDescriberDeps): PhotoDescriber {
  return async (photo, ctx, opts = { allowGenerate: true }) => {
    const cached = deps.store.get(photo.uniqueId);
    if (cached) return { text: cached, generated: false };
    if (!opts.allowGenerate) return null;

    const record = {
      ts: Date.now(),
      chatId: ctx.chatId,
      userId: ctx.userId,
      userName: ctx.userName,
      triggerMsgId: 0,
      model: deps.model,
      // У звіті видно, добові ліміти не зʼїдає.
      weight: 0,
    };
    try {
      const fetched = await deps.photoFetcher(photo.fileId, photo.uniqueId);
      const mime = fetched.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      const reply = await deps.llmClient.reply(
        PHOTO_DESCRIBE_PROMPT,
        [
          { type: "image", source: { type: "base64", media_type: mime, data: fetched.base64 } },
          { type: "text", text: "Опиши це фото." },
        ],
        deps.model,
        DESCRIBE_MAX_TOKENS,
      );
      const cost = calculateCost(deps.model, {
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
      });
      deps.llmCallStore.record({
        ...record,
        status: "ok",
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        ...(cost !== null ? { costUsd: cost } : {}),
      });
      const text = reply.text.trim().replace(/\s+/g, " ");
      if (!text) return null;
      deps.store.put(photo.uniqueId, text, deps.model);
      deps.log.debug({ uniqueId: photo.uniqueId, cost }, "photo described");
      return { text, generated: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.llmCallStore.record({ ...record, status: "error", errorMessage });
      deps.log.warn({ err: errorMessage, uniqueId: photo.uniqueId }, "photo describe failed");
      return null;
    }
  };
}
