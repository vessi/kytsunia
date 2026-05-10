import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import { getRecentMessages } from "../storage/messages.js";
import type { RegularsStore } from "../storage/regulars.js";
import type { LlmClient } from "./anthropic.js";
import { buildLlmRequest } from "./context.js";
import { calculateCost } from "./pricing.js";
import { collectProfiles } from "./profiles.js";

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
};

const RATE_LIMIT_REPLIES = [
  "Дядя, ти вже мене сьогодні замучив. Завтра.",
  "Усе, на сьогодні досить.",
  "Іди читай книжку, я в режимі економії.",
];

export async function invokeLlmReply(
  ctx: Context,
  replyTo: number,
  deps: InvokeLlmDeps,
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;
  const userName = ctx.from?.first_name ?? "";
  const text = ctx.message?.text ?? "";

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

  // 3. Build context and call API
  const recent = getRecentMessages(deps.db, chatId, deps.recentContextSize, replyTo);
  const profiles = collectProfiles(deps.regularsStore, userId, chatId, recent, deps.profilesLimit);
  const { system, userMessage } = buildLlmRequest(
    { senderName: userName, text },
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
