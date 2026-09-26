import type { Context } from "grammy";
import { replyInChunks } from "../chunks.js";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { Db } from "../storage/db.js";
import type { InstructionStore } from "../storage/instructions.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages, type RecentMessageRow } from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import { formatKyivDate, formatKyivTime } from "../time.js";
import type { TypingStarter } from "../typing.js";
import type { LlmClient, SystemBlock } from "./anthropic.js";
import { withSpecialInstructions } from "./persona.js";
import { calculateCost } from "./pricing.js";
import { collectChatProfiles, type ProfileEntry, renderProfilesBlock } from "./profiles.js";

// Дайджест довший за звичайний реплай: 3-7 пунктів + репліка від себе.
// Модель думає завжди, і роздуми входять у цей самий бюджет, тож із запасом:
// текст на два повідомлення Telegram — це ~3k токенів, плюс роздуми.
const DIGEST_MAX_TOKENS = 6000;

// Менше за це — дайджест робити нема з чого, і не варто палити виклик.
const MIN_MESSAGES = 5;

export type InvokeDigestDeps = {
  enabled: boolean;
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  db: Db;
  // Модель дайджесту за замовчуванням; чат може задати свою.
  model: string;
  prompt: string;
  defaultCount: number;
  maxCount: number;
  // Скільки слотів добового ліміту зʼїдає один дайджест.
  weight: number;
  defaultDailyLimit: number;
  globalDailyCap: number;
  log: Logger;
  // Поновлює «друкує…», поки модель пише дайджест.
  startTyping: TypingStarter;
  // Спеціальні інструкції адміна для чату, дописуються до промпту дайджесту.
  instructionStore: InstructionStore;
  // Стеля повідомлень на чат: замінює maxCount, якщо задана, і вгору теж.
  chatSettings: ChatSettingsStore;
  // Профілі постійних учасників: дайджест знає, хто є хто.
  regularsStore: RegularsStore;
  botUserId?: number;
};

/**
 * Скільки повідомлень реально брати. Без числа — дефолт із конфіга,
 * з числом — клампимо в [1, maxCount], щоб «дайджест за 100000» не з'їв
 * пів бази і не приїхав у модель мегабайтом тексту.
 */
export function resolveCount(
  requested: number | undefined,
  defaultCount: number,
  maxCount: number,
): number {
  if (requested === undefined) return Math.min(defaultCount, maxCount);
  if (!Number.isFinite(requested)) return Math.min(defaultCount, maxCount);
  return Math.min(Math.max(Math.trunc(requested), 1), maxCount);
}

function photoMarker(count: number): string {
  if (count === 0) return "";
  if (count === 1) return "[фото] ";
  return `[фото ×${count}] `;
}

/**
 * Транскрипт для моделі: «[HH:MM] Ім'я: текст», з роздільником при зміні доби.
 * Фото йдуть маркером, а не картинкою — 300 повідомлень з фото коштували б
 * абсурдних грошей, та й дайджест про текст, а не про зображення.
 */
export function renderTranscript(rows: readonly RecentMessageRow[]): string {
  const lines: string[] = [];
  let currentDay: string | null = null;

  for (const row of rows) {
    const day = formatKyivDate(row.ts);
    if (day !== currentDay) {
      lines.push(`--- ${day} ---`);
      currentDay = day;
    }
    const marker = photoMarker(row.photos.length);
    lines.push(`[${formatKyivTime(row.ts)}] ${row.senderName}: ${marker}${row.text}`.trimEnd());
  }

  return lines.join("\n");
}

export function buildDigestRequest(
  rows: readonly RecentMessageRow[],
  prompt: string,
  profiles: readonly ProfileEntry[] = [],
): { system: SystemBlock[]; userMessage: string } {
  // Промпт сам по собі коротший за мінімальний кешований префікс, тож
  // брейкпойнт ставимо на профілях: разом з ними префікс уже вартий кешу, а
  // змінюються вони лише після «онови профілі». Транскрипт щоразу інший —
  // він у user message без кешу.
  const system: SystemBlock[] = [{ type: "text", text: prompt }];
  const profilesBlock = renderProfilesBlock(profiles);
  if (profilesBlock) {
    system.push({ type: "text", text: profilesBlock, cache_control: { type: "ephemeral" } });
  }
  const userMessage = `Ось останні ${rows.length} повідомлень чату:\n\n${renderTranscript(
    rows,
  )}\n\nЗроби дайджест.`;
  return { system, userMessage };
}

export async function invokeDigest(
  ctx: Context,
  replyTo: number,
  requestedCount: number | undefined,
  deps: InvokeDigestDeps,
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;
  const userName = ctx.from?.first_name ?? "";
  // Модель дайджесту чату, якщо адмін її задав, інакше глобальна. Від моделі
  // відповідей чату не залежить.
  const model = deps.chatSettings.getDigestModel(chatId) ?? deps.model;
  // Стеля чату замінює глобальну в обидва боки: адмін може і врізати, і
  // підняти. Ріже і явне число, і дефолт.
  const maxCount = deps.chatSettings.getDigestMaxCount(chatId) ?? deps.maxCount;
  const count = resolveCount(requestedCount, deps.defaultCount, maxCount);

  if (!deps.enabled) {
    deps.log.debug({ chatId, userId }, "digest requested while disabled");
    await ctx.reply("Дайджест зараз вимкнений.", { reply_to_message_id: replyTo });
    return;
  }

  const baseRecord = {
    ts: Date.now(),
    chatId,
    userId,
    userName,
    triggerMsgId: replyTo,
    model,
    weight: deps.weight,
  };

  // 1. Ліміти. Дайджест важить weight слотів, тому перевіряємо не «чи лишився
  //    хоч один», а «чи лишилось weight» — інакше останній слот дня пішов би
  //    на виклик, що коштує як десяток.
  const globalStatus = deps.llmCallStore.checkGlobalRate(deps.globalDailyCap);
  if (deps.globalDailyCap - globalStatus.used < deps.weight) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "global_cap" });
    deps.log.warn({ chatId, userId, used: globalStatus.used }, "global cap reached for digest");
    await ctx.reply("На сьогодні досить, до завтра.", { reply_to_message_id: replyTo });
    return;
  }

  const userStatus = deps.llmCallStore.checkUserRate(userId, deps.defaultDailyLimit);
  if (userStatus.limit !== null && userStatus.limit - userStatus.used < deps.weight) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "user_limit" });
    await ctx.reply(`Дайджест коштує ${deps.weight} звичайних відповідей, а в тебе стільки нема.`, {
      reply_to_message_id: replyTo,
    });
    return;
  }

  // 2. Історія. Тригерне повідомлення виключаємо — воно і є «зроби дайджест».
  const rows = getRecentMessages(deps.db, chatId, count, replyTo);
  if (rows.length < MIN_MESSAGES) {
    deps.log.debug({ chatId, found: rows.length }, "digest: not enough messages");
    await ctx.reply("Нема з чого робити дайджест, у вас тут тиша.", {
      reply_to_message_id: replyTo,
    });
    return;
  }

  const prompt = withSpecialInstructions(
    deps.prompt,
    deps.instructionStore.list(chatId).map((i) => i.text),
  );
  const profiles = collectChatProfiles(deps.regularsStore, chatId, deps.botUserId);
  const { system, userMessage } = buildDigestRequest(rows, prompt, profiles);
  const stopTyping = deps.startTyping(ctx);

  try {
    const reply = await deps.llmClient.reply(system, userMessage, model, DIGEST_MAX_TOKENS);
    const cost = calculateCost(model, {
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

    deps.log.info(
      {
        chatId,
        userId,
        requested: requestedCount ?? null,
        used: rows.length,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cost,
      },
      "digest ok",
    );

    if (reply.stopReason === "max_tokens") {
      deps.log.warn({ chatId, userId, outputTokens: reply.outputTokens }, "digest cut short");
    }
    // Порожній текст буває, якщо модель витратила весь бюджет на роздуми —
    // Telegram на порожньому повідомленні впаде, тож підстраховуємось.
    const text = reply.text.trim() || "Не склалось у дайджест, спробуй ще раз.";

    // Дайджест НЕ зберігаємо в messages, на відміну від звичайних відповідей:
    // це кілька тисяч символів, які б витіснили половину recent-контексту
    // наступних реплаїв (і потрапили б у наступний же дайджест).
    await replyInChunks(ctx, text, replyTo);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    deps.llmCallStore.record({ ...baseRecord, status: "error", errorMessage });
    deps.log.error({ err: errorMessage, chatId, userId }, "digest failed");
    await ctx.reply("Щось не вийшло, спробуй пізніше.", { reply_to_message_id: replyTo });
  } finally {
    stopTyping();
  }
}
