import type { Context } from "grammy";
import { replyInChunks } from "../chunks.js";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { Db } from "../storage/db.js";
import type { DigestRecord, DigestStore } from "../storage/digests.js";
import type { InstructionStore } from "../storage/instructions.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages, type RecentMessageRow } from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import { messageLink } from "../tg-links.js";
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
  // Кешовані описи фото для транскрипту; нових не генерує.
  photoDescriptions?: { get: (uniqueId: string) => string | null };
  // Повторні дайджести: посилання замість повтору, продовження замість переказу.
  digestStore: DigestStore;
  reuseWindowMs: number;
  minNewMessages: number;
  now: () => number;
};

// Попередній дайджест, вікно якого перетинається з новим: текст замість його
// повідомлень, а транскриптом — лише те, чого він не покрив.
export type PreviousDigest = {
  text: string;
  older: readonly RecentMessageRow[];
  newer: readonly RecentMessageRow[];
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

function photoMarker(count: number, notes: readonly string[]): string {
  if (notes.length > 0) return `[фото: ${notes.join("; ")}] `;
  if (count === 0) return "";
  if (count === 1) return "[фото] ";
  return `[фото ×${count}] `;
}

/**
 * Транскрипт для моделі: «[HH:MM] Ім'я: текст», з роздільником при зміні доби.
 * Фото йдуть маркером, а не картинкою — 300 повідомлень з фото коштували б
 * абсурдних грошей. Якщо для фото вже є опис у кеші (його зробили для
 * контексту відповідей), маркер несе його: нових описів дайджест не генерує.
 */
export function renderTranscript(
  rows: readonly RecentMessageRow[],
  describe: (uniqueId: string) => string | null = () => null,
): string {
  const lines: string[] = [];
  let currentDay: string | null = null;
  // Час ставимо лише коли змінилась година: на сотнях рядків «[HH:MM]» на
  // кожному — це 10% транскрипту, а дайджесту вистачає й грубої сітки.
  let currentHour: string | null = null;

  for (const row of rows) {
    const day = formatKyivDate(row.ts);
    if (day !== currentDay) {
      lines.push(`--- ${day} ---`);
      currentDay = day;
      currentHour = null;
    }
    const notes = row.photos
      .map((p) => describe(p.uniqueId))
      .filter((d): d is string => d !== null);
    const marker = photoMarker(row.photos.length, notes);
    const time = formatKyivTime(row.ts);
    const hour = time.slice(0, 2);
    const stamp = hour === currentHour ? "" : `[${time}] `;
    currentHour = hour;
    lines.push(`${stamp}${row.senderName}: ${marker}${row.text}`.trimEnd());
  }

  return lines.join("\n");
}

export function buildDigestRequest(
  rows: readonly RecentMessageRow[],
  prompt: string,
  profiles: readonly ProfileEntry[] = [],
  describe?: (uniqueId: string) => string | null,
  previous?: PreviousDigest,
): { system: SystemBlock[]; userMessage: string } {
  // Без cache_control: дайджести рідкі, тож запис кешу під окремим префіксом
  // (промпт дайджесту + профілі) майже ніколи не читається, а коштує 1.25x.
  // Транскрипт щоразу інший — він у user message.
  const system: SystemBlock[] = [{ type: "text", text: prompt }];
  const profilesBlock = renderProfilesBlock(profiles);
  if (profilesBlock) {
    system.push({ type: "text", text: profilesBlock });
  }
  if (previous) {
    const parts = [
      `Дайджест за вікно з ${rows.length} повідомлень. Середину вікна вже покриває попередній дайджест — ось він, замість тих повідомлень:\n\n${previous.text}`,
    ];
    if (previous.older.length > 0) {
      parts.push(
        `Повідомлення до попереднього дайджесту (${previous.older.length}):\n\n${renderTranscript(previous.older, describe)}`,
      );
    }
    if (previous.newer.length > 0) {
      parts.push(
        `Повідомлення після попереднього дайджесту (${previous.newer.length}):\n\n${renderTranscript(previous.newer, describe)}`,
      );
    }
    parts.push(
      "Зроби дайджест за все вікно: для покритої частини спирайся на попередній дайджест і не переказуй його дослівно, а решту додай як є. Якщо нове лише після попереднього — починай з нього.",
    );
    return { system, userMessage: parts.join("\n\n") };
  }
  const userMessage = `Ось останні ${rows.length} повідомлень чату:\n\n${renderTranscript(
    rows,
    describe,
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

  // 1. Історія. Тригерне повідомлення виключаємо — воно і є «зроби дайджест».
  const rows = getRecentMessages(deps.db, chatId, count, replyTo);
  if (rows.length < MIN_MESSAGES) {
    deps.log.debug({ chatId, found: rows.length }, "digest: not enough messages");
    await ctx.reply("Нема з чого робити дайджест, у вас тут тиша.", {
      reply_to_message_id: replyTo,
    });
    return;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return;

  // 2. Свіжий дайджест із вікном, що перетинається. Непокритих мало —
  //    посилання на нього, без моделі й без слота в лімітах. Інакше модель
  //    отримає його текст і лише непокриті повідомлення.
  const prev = deps.digestStore.latestOverlapping(
    chatId,
    first.msgId,
    last.msgId,
    deps.now() - deps.reuseWindowMs,
  );
  let previous: PreviousDigest | undefined;
  let prevLink: string | null = null;
  if (prev) {
    const older = rows.filter((r) => r.msgId < prev.fromMsgId);
    const newer = rows.filter((r) => r.msgId > prev.toMsgId);
    prevLink = messageLink(chatId, prev.messageId);
    if (older.length + newer.length < deps.minNewMessages) {
      deps.log.info(
        { chatId, userId, prevTs: prev.ts, uncovered: older.length + newer.length },
        "digest: reusing previous",
      );
      const when = formatKyivTime(prev.ts);
      await ctx.reply(
        prevLink ? `Робила о ${when}, ось: ${prevLink}` : `Робила о ${when}, дивись вище.`,
        {
          reply_parameters: { message_id: prev.messageId },
          ...(prevLink ? { link_preview_options: { is_disabled: true } } : {}),
        },
      );
      return;
    }
    previous = { text: prev.text, older, newer };
  }

  // 3. Ліміти. Дайджест важить weight слотів, тому перевіряємо не «чи лишився
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

  const prompt = withSpecialInstructions(
    deps.prompt,
    deps.instructionStore.list(chatId).map((i) => i.text),
  );
  const profiles = collectChatProfiles(deps.regularsStore, chatId, deps.botUserId);
  const { system, userMessage } = buildDigestRequest(
    rows,
    prompt,
    profiles,
    deps.photoDescriptions ? (id) => deps.photoDescriptions?.get(id) ?? null : undefined,
    previous,
  );
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
    // наступних реплаїв (і потрапили б у наступний же дайджест). Зате
    // пишемо в digests — для посилань і продовжень.
    const outgoing = previous && prevLink ? `${text}\n\nПопередній дайджест: ${prevLink}` : text;
    const sent = await replyInChunks(
      ctx,
      outgoing,
      replyTo,
      prevLink ? { link_preview_options: { is_disabled: true } } : {},
    );
    const firstSent = sent[0];
    if (firstSent) {
      const record: DigestRecord = {
        chatId,
        ts: deps.now(),
        messageId: firstSent.message_id,
        fromMsgId: first.msgId,
        toMsgId: last.msgId,
        count: rows.length,
        text,
      };
      deps.digestStore.record(record);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    deps.llmCallStore.record({ ...baseRecord, status: "error", errorMessage });
    deps.log.error({ err: errorMessage, chatId, userId }, "digest failed");
    await ctx.reply("Щось не вийшло, спробуй пізніше.", { reply_to_message_id: replyTo });
  } finally {
    stopTyping();
  }
}
