import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { Db } from "../storage/db.js";
import type { InstructionStore } from "../storage/instructions.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages, type MessageAppender } from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import { formatKyivNow, startOfKyivDay } from "../time.js";
import type { CacheTtl, LlmClient, SystemBlock } from "./anthropic.js";
import { renderTranscript } from "./digest.js";
import { renderInstructionsBlock } from "./persona.js";
import { calculateCost } from "./pricing.js";
import { collectChatProfiles, renderProfilesBlock } from "./profiles.js";

// Що модель відповідає, коли сказати нема чого. Порівнюємо без розділових знаків.
export const SILENCE = "мовчу";

export const CHIME_PROMPT = `Тебе ніхто не кликав: розмова в чаті йде без тебе, а це просто нагода вставити слово. Нижче — останні повідомлення.

Влазь лише тоді, коли справді є що додати: влучний коментар до теми, факт, якого бракує, або жарт, який просить сам контекст. Одна коротка репліка, як завжди, у своєму стилі, по темі останніх повідомлень. Не звертайся до когось особисто, якщо репліка не про нього. Не влазь у важкі, особисті чи сумні розмови, у суперечки про політику і в те, що тебе не стосується. Не повторюй того, що вже сказали.

Якщо додати нема чого, або ти сумніваєшся, відповідай рівно одним словом: ${SILENCE}. Мовчати — нормально, це має бути найчастіша відповідь.`;

export type ChimeDeps = {
  db: Db;
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  chatSettings: ChatSettingsStore;
  regularsStore: RegularsStore;
  instructionStore: InstructionStore;
  model: string;
  digestModel: string;
  persona: (model: string, digestModel: string, character: string | null) => string;
  cacheTtl: CacheTtl;
  botUserId: number;
  botName: string;
  replyMaxTokens: number;
  globalDailyCap: number;
  // Скільки останніх повідомлень показати як контекст для рішення.
  contextSize: number;
  appendMessage: MessageAppender;
  photoDescriptions?: { get: (uniqueId: string) => string | null };
  now: () => number;
  log: Logger;
};

export function isSilence(text: string): boolean {
  return (
    text
      .trim()
      .replace(/[.!…,"«»]/g, "")
      .toLowerCase() === SILENCE
  );
}

/**
 * Одна спроба влізти в розмову. Модель бачить ті самі кешовані блоки, що й у
 * відповідях (персона, блок чату), плюс останні contextSize повідомлень і
 * інструкцію мовчати, якщо нема чого сказати. Повертає true, якщо написала.
 */
export async function invokeChime(ctx: Context, chatId: number, deps: ChimeDeps): Promise<boolean> {
  const rows = getRecentMessages(deps.db, chatId, deps.contextSize);
  if (rows.length === 0) return false;
  const last = rows[rows.length - 1];
  if (!last) return false;

  const model = deps.chatSettings.getModel(chatId) ?? deps.model;
  const digestModel = deps.chatSettings.getDigestModel(chatId) ?? deps.digestModel;
  const cache = { type: "ephemeral" as const, ttl: deps.cacheTtl };
  const persona = deps.persona(model, digestModel, deps.chatSettings.getPersona(chatId));
  const chatSections = [
    renderInstructionsBlock(deps.instructionStore.list(chatId).map((i) => i.text)),
    renderProfilesBlock(collectChatProfiles(deps.regularsStore, chatId, deps.botUserId)),
  ].filter((s) => s.length > 0);
  const transcript = renderTranscript(rows, (id) => deps.photoDescriptions?.get(id) ?? null);
  const system: SystemBlock[] = [
    { type: "text", text: persona, cache_control: cache },
    ...(chatSections.length > 0
      ? [{ type: "text" as const, text: chatSections.join("\n\n"), cache_control: cache }]
      : []),
    {
      type: "text",
      text: `Зараз ${formatKyivNow(deps.now())} за київським часом.\n\n${CHIME_PROMPT}\n\nОстанні ${rows.length} повідомлень:\n${transcript}`,
    },
  ];

  const record = {
    ts: deps.now(),
    chatId,
    userId: deps.botUserId,
    userName: deps.botName,
    triggerMsgId: last.msgId,
    model,
    weight: 1,
  };
  const globalStatus = deps.llmCallStore.checkGlobalRate(deps.globalDailyCap);
  if (!globalStatus.allowed) {
    deps.log.debug({ chatId }, "chime skipped: global cap");
    return false;
  }

  try {
    const reply = await deps.llmClient.reply(
      system,
      "Є що додати? Якщо ні — одне слово: мовчу.",
      model,
      deps.replyMaxTokens,
    );
    const cost = calculateCost(model, {
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
    const text = reply.text.trim();
    if (!text || isSilence(text)) {
      deps.log.debug({ chatId, cost }, "chime: silence");
      return false;
    }
    const sent = await ctx.api.sendMessage(chatId, text, {
      reply_parameters: { message_id: last.msgId },
    });
    deps.appendMessage({
      chatId,
      messageId: sent.message_id,
      ts: sent.date * 1000,
      senderId: deps.botUserId,
      senderName: deps.botName,
      text,
      kind: "text",
      replyTo: { messageId: last.msgId, authorId: last.senderId, authorName: last.senderName },
    });
    deps.log.info({ chatId, cost }, "chime: spoke");
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    deps.llmCallStore.record({ ...record, status: "error", errorMessage });
    deps.log.error({ chatId, err: errorMessage }, "chime failed");
    return false;
  }
}

export type ChimePolicy = {
  dailyCap: number;
  minGapMs: number;
  // Тихі години за Києвом: [from, to). Якщо from > to — інтервал через північ.
  quietFromHour: number;
  quietToHour: number;
};

/**
 * Вирішує, чи час пробувати: шанс на повідомлення (з налаштувань чату), а
 * далі тихі години, пауза й добова стеля. Лічильники в памʼяті процесу:
 * після рестарту нульові, це прийнятно.
 */
export function makeChimeScheduler(
  policy: ChimePolicy,
  rng: () => number = Math.random,
  now: () => number = Date.now,
) {
  const lastChimeTs = new Map<number, number>();
  const spokenToday = new Map<number, { day: number; n: number }>();

  const kyivHour = (ts: number) =>
    Number.parseInt(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Kyiv",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(ts)),
      10,
    ) % 24;

  const isQuiet = (ts: number) => {
    const h = kyivHour(ts);
    const { quietFromHour: from, quietToHour: to } = policy;
    if (from === to) return false;
    return from < to ? h >= from && h < to : h >= from || h < to;
  };

  return {
    /**
     * Викликати на кожне «звичайне» повідомлення чату з шансом цього чату.
     * true — час пробувати.
     */
    noteMessage: (chatId: number, chance: number): boolean => {
      if (chance <= 0 || rng() >= chance) return false;
      const ts = now();
      if (isQuiet(ts)) return false;
      const last = lastChimeTs.get(chatId) ?? 0;
      if (ts - last < policy.minGapMs) return false;
      const day = startOfKyivDay(new Date(ts));
      const today = spokenToday.get(chatId);
      if (today && today.day === day && today.n >= policy.dailyCap) return false;
      return true;
    },
    /** Викликати, коли Кицюня справді написала. */
    noteSpoke: (chatId: number): void => {
      const ts = now();
      lastChimeTs.set(chatId, ts);
      const day = startOfKyivDay(new Date(ts));
      const today = spokenToday.get(chatId);
      spokenToday.set(chatId, today && today.day === day ? { day, n: today.n + 1 } : { day, n: 1 });
    },
  };
}

export type ChimeScheduler = ReturnType<typeof makeChimeScheduler>;
