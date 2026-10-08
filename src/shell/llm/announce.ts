import type { Api } from "grammy";
import { splitForTelegram } from "../chunks.js";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { ChatsStore } from "../storage/chats.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import type { CacheTtl, LlmClient, SystemBlock } from "./anthropic.js";
import { calculateCost } from "./pricing.js";

// Оголошення — кілька речень, не простирадло.
const ANNOUNCE_MAX_TOKENS = 1500;

export const ANNOUNCE_PROMPT = `Адмін просить тебе розповісти цьому чату новини про тебе саму — що змінилось після оновлення. Нижче його нотатки.

Перекажи їх своїми словами, у своєму стилі, як коротке оголошення: до пʼяти-шести речень, без markdown і без нумерації. Не додавай нічого, чого в нотатках нема, і не пропускай пунктів, які стосуються учасників. Технічні деталі, що людей не стосуються, можна опустити.`;

export type AnnounceDeps = {
  api: Pick<Api, "sendMessage">;
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  chats: ChatsStore;
  chatSettings: ChatSettingsStore;
  model: string;
  digestModel: string;
  persona: (model: string, digestModel: string, character: string | null) => string;
  cacheTtl: CacheTtl;
  botUserId: number;
  botName: string;
  log: Logger;
};

export type AnnounceResult = { sent: number; failed: number; skipped: number; costUsd: number };

/**
 * Надсилає оголошення в усі активні групові чати з увімкненими оголошеннями.
 * inPersona — переказ нотаток моделлю, окремо для кожного чату (персона й
 * модель на чат). Чат, куди надіслати не вдалось (бота викинули), позначаємо
 * як покинутий.
 */
export async function announce(
  deps: AnnounceDeps,
  notes: string,
  inPersona: boolean,
): Promise<AnnounceResult> {
  const result: AnnounceResult = { sent: 0, failed: 0, skipped: 0, costUsd: 0 };
  for (const chat of deps.chats.listActive()) {
    if (!chat.announce) {
      result.skipped += 1;
      continue;
    }
    let text = notes;
    if (inPersona) {
      const model = deps.chatSettings.getModel(chat.chatId) ?? deps.model;
      const digestModel = deps.chatSettings.getDigestModel(chat.chatId) ?? deps.digestModel;
      const persona = deps.persona(model, digestModel, deps.chatSettings.getPersona(chat.chatId));
      const system: SystemBlock[] = [
        { type: "text", text: persona, cache_control: { type: "ephemeral", ttl: deps.cacheTtl } },
        { type: "text", text: ANNOUNCE_PROMPT },
      ];
      const record = {
        ts: Date.now(),
        chatId: chat.chatId,
        userId: deps.botUserId,
        userName: deps.botName,
        triggerMsgId: 0,
        model,
        weight: 0,
      };
      try {
        const reply = await deps.llmClient.reply(
          system,
          `Нотатки адміна:\n${notes}`,
          model,
          ANNOUNCE_MAX_TOKENS,
        );
        const cost =
          calculateCost(model, {
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cacheReadTokens: reply.cacheReadTokens,
            cacheWriteTokens: reply.cacheWriteTokens,
          }) ?? 0;
        result.costUsd += cost;
        deps.llmCallStore.record({
          ...record,
          status: "ok",
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          cacheWriteTokens: reply.cacheWriteTokens,
          costUsd: cost,
        });
        text = reply.text.trim() || notes;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        deps.llmCallStore.record({ ...record, status: "error", errorMessage });
        deps.log.warn(
          { chatId: chat.chatId, err: errorMessage },
          "announce: persona rewrite failed, sending notes",
        );
      }
    }
    try {
      for (const chunk of splitForTelegram(text)) {
        await deps.api.sendMessage(chat.chatId, chunk);
      }
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn({ chatId: chat.chatId, err: message }, "announce: send failed");
      result.failed += 1;
      if (/kicked|not a member|chat not found|bot was blocked/i.test(message))
        deps.chats.left(chat.chatId);
    }
  }
  deps.log.info({ ...result, costUsd: result.costUsd.toFixed(4) }, "announce done");
  return result;
}
