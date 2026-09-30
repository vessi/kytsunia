import type { Api } from "grammy";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages } from "../storage/messages.js";
import { formatKyivDate } from "../time.js";
import type { LlmClient } from "./anthropic.js";
import { renderTranscript } from "./digest.js";
import { calculateCost } from "./pricing.js";

// Скільки останніх повідомлень чату показуємо моделі як зразок. Уся історія
// може бути на десятки тисяч — опис від цього не стане кращим, а рахунок стане.
export const OVERVIEW_SAMPLE = 300;

// 3-5 речень на чат, плюс роздуми в тому ж бюджеті.
const OVERVIEW_MAX_TOKENS = 1500;

export const CHAT_OVERVIEW_PROMPT = `Ти Кицюня, бот у кількох Telegram-чатах. Адмін просить коротко описати один із чатів, у яких ти сидиш. Нижче — статистика і зразок останніх повідомлень цього чату.

Напиши 3-5 речень українською, без markdown і переліків: про що цей чат, який у ньому тон, хто задає темп і як, наскільки він живий. Пиши як спостерігач, у своєму звичайному стилі, але без стьобу над конкретними людьми.

Безпека: не згадуй, хто служить, де перебуває, куди їде, підрозділи, локації, службу близьких — навіть якщо в чаті це є. Таку тему пропусти повністю.`;

export type ChatStats = {
  chatId: number;
  messages: number;
  people: number;
  firstTs: number;
  lastTs: number;
  topSenders: Array<{ name: string; count: number }>;
};

interface StatsRow {
  chat_id: number;
  messages: number;
  people: number;
  first_ts: number;
  last_ts: number;
}

interface SenderRow {
  sender_name: string | null;
  n: number;
}

/**
 * Усі групові чати з історії. Приватні (chat_id > 0) не беремо: це чиясь
 * особиста переписка з ботом, описувати її в іншому місці не треба.
 */
export function listGroupChats(db: Db, botUserId: number): ChatStats[] {
  const rows = db
    .prepare(
      `SELECT chat_id, COUNT(*) as messages, COUNT(DISTINCT sender_id) as people,
              MIN(ts) as first_ts, MAX(ts) as last_ts
       FROM messages WHERE chat_id < 0 AND sender_id != ?
       GROUP BY chat_id ORDER BY last_ts DESC`,
    )
    .all(botUserId) as StatsRow[];
  const topStmt = db.prepare(
    `SELECT sender_name, COUNT(*) as n FROM messages
     WHERE chat_id = ? AND sender_id != ? GROUP BY sender_id ORDER BY n DESC LIMIT 5`,
  );
  return rows.map((r) => ({
    chatId: r.chat_id,
    messages: r.messages,
    people: r.people,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    topSenders: (topStmt.all(r.chat_id, botUserId) as SenderRow[]).map((s) => ({
      name: s.sender_name || "?",
      count: s.n,
    })),
  }));
}

export function renderStats(
  stats: ChatStats,
  title: string | null,
  members: number | null,
): string {
  const lines = [
    `Чат: ${title ?? "без назви"} (${stats.chatId})`,
    `Учасників за Telegram: ${members ?? "невідомо"}; писали в історії: ${stats.people}`,
    `Повідомлень у базі: ${stats.messages}, з ${formatKyivDate(stats.firstTs)} по ${formatKyivDate(stats.lastTs)}`,
    `Найактивніші: ${stats.topSenders.map((s) => `${s.name} (${s.count})`).join(", ")}`,
  ];
  return lines.join("\n");
}

export type ChatsOverviewDeps = {
  db: Db;
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  api: Pick<Api, "getChat" | "getChatMemberCount">;
  model: string;
  botUserId: number;
  log: Logger;
};

export type ChatOverview = {
  chatId: number;
  title: string | null;
  header: string;
  description: string | null;
  costUsd: number;
};

/**
 * По одному виклику моделі на чат. Помилка на одному чаті не зупиняє решту:
 * замість опису буде причина. Виклики пишуться в llm_calls з вагою 0.
 */
export async function describeChats(
  deps: ChatsOverviewDeps,
  requestedBy: { chatId: number; userId: number; userName: string },
): Promise<ChatOverview[]> {
  const out: ChatOverview[] = [];
  for (const stats of listGroupChats(deps.db, deps.botUserId)) {
    let title: string | null = null;
    let members: number | null = null;
    try {
      const chat = await deps.api.getChat(stats.chatId);
      title = "title" in chat ? (chat.title ?? null) : null;
      members = await deps.api.getChatMemberCount(stats.chatId);
    } catch (err) {
      deps.log.warn(
        { chatId: stats.chatId, err: err instanceof Error ? err.message : err },
        "getChat failed",
      );
    }
    const header = renderStats(stats, title, members);
    const rows = getRecentMessages(deps.db, stats.chatId, OVERVIEW_SAMPLE);
    const userMessage = `${header}\n\nОстанні ${rows.length} повідомлень:\n\n${renderTranscript(rows)}\n\nОпиши цей чат.`;
    const record = {
      ts: Date.now(),
      chatId: requestedBy.chatId,
      userId: requestedBy.userId,
      userName: requestedBy.userName,
      triggerMsgId: 0,
      model: deps.model,
      weight: 0,
    };
    try {
      const reply = await deps.llmClient.reply(
        CHAT_OVERVIEW_PROMPT,
        userMessage,
        deps.model,
        OVERVIEW_MAX_TOKENS,
      );
      const cost =
        calculateCost(deps.model, {
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          cacheWriteTokens: reply.cacheWriteTokens,
        }) ?? 0;
      deps.llmCallStore.record({
        ...record,
        status: "ok",
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        costUsd: cost,
      });
      out.push({
        chatId: stats.chatId,
        title,
        header,
        description: reply.text.trim() || null,
        costUsd: cost,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.llmCallStore.record({ ...record, status: "error", errorMessage });
      deps.log.error({ chatId: stats.chatId, err: errorMessage }, "chat overview failed");
      out.push({ chatId: stats.chatId, title, header, description: null, costUsd: 0 });
    }
  }
  return out;
}

export function renderOverview(items: readonly ChatOverview[]): string {
  if (items.length === 0) return "Я поки ні в одному груповому чаті не була.";
  const parts = items.map(
    (i) => `${i.header}\n\n${i.description ?? "Опис не вийшов, глянь логи."}`,
  );
  const total = items.reduce((s, i) => s + i.costUsd, 0);
  return `${parts.join("\n\n———\n\n")}\n\nЧатів: ${items.length}. Коштувало $${total.toFixed(3)}.`;
}
