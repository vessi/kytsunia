import type { Context } from "grammy";
import { replyInChunks } from "../chunks.js";
import type { Logger } from "../logger.js";
import type { ChatSettingsStore } from "../storage/chat-settings.js";
import type { InstructionStore } from "../storage/instructions.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import type { RegularProfile, RegularsStore } from "../storage/regulars.js";
import type { TypingStarter } from "../typing.js";
import type { LlmClient, SystemBlock } from "./anthropic.js";
import { withSpecialInstructions } from "./persona.js";
import { calculateCost } from "./pricing.js";

// Три речення на людину ≈ 100 токенів; на 20 людей — 2k тексту, а роздуми
// моделі йдуть у той самий бюджет, тож із запасом.
const ROSTER_MAX_TOKENS = 5000;

// Більше людей — і в ліміт Telegram не влізе, і читати ніхто не буде.
export const ROSTER_MAX_PEOPLE = 20;

export const ROSTER_PROMPT = `Тебе попросили розказати про учасників чату. Нижче — профілі, які ти склала з їхніх повідомлень.

Правила саме для цієї відповіді (вони важливіші за правило про 1-3 речення на відповідь):
- Про кожну людину — окремий абзац, щонайбільше три речення, у твоєму звичайному тоні.
- Абзац починається з імені так, як воно в профілі.
- Тільки з профілю. Нічого не вигадуй і не додавай від себе те, чого там немає.
- Порядок — як у списку.
- Без markdown, без нумерації, без заголовків, без вступу і без підсумку.
- «Службові примітки» біля профілю — це підказки для тебе, як говорити про людину. Їх не переказуй.
- Безпека важливіша за формат: нічого про службу, підрозділи, місцеперебування, переїзди, оборонну чи інфраструктурну роботу, службу близьких, навіть якщо в профілі це є.`;

export type InvokeRosterDeps = {
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  regularsStore: RegularsStore;
  optedOutUserIds: () => ReadonlySet<number>;
  botUserId?: number;
  instructionStore: InstructionStore;
  chatSettings: ChatSettingsStore;
  // Модель і персона — ті самі, що для звичайних відповідей у цьому чаті.
  model: string;
  digestModel: string;
  persona: (model: string, digestModel: string, character: string | null) => string;
  defaultDailyLimit: number;
  globalDailyCap: number;
  log: Logger;
  startTyping: TypingStarter;
};

/**
 * Профілі для моделі: імʼя, текст, за потреби примітки адміна окремим рядком.
 * Opt-out перевіряємо ще раз: профіль стирається при відмові, але хай буде.
 */
export function selectRosterProfiles(
  profiles: readonly RegularProfile[],
  optedOut: ReadonlySet<number>,
  max: number = ROSTER_MAX_PEOPLE,
): RegularProfile[] {
  return profiles.filter((p) => !optedOut.has(p.userId)).slice(0, max);
}

export function renderRosterProfiles(profiles: readonly RegularProfile[]): string {
  return profiles
    .map((p) => {
      const name = p.displayName ?? String(p.userId);
      const notes = p.manualNotes ? `\nСлужбові примітки: ${p.manualNotes}` : "";
      return `${name}:\n${p.profile}${notes}`;
    })
    .join("\n\n");
}

export async function invokeRoster(
  ctx: Context,
  replyTo: number,
  deps: InvokeRosterDeps,
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;
  const userName = ctx.from?.first_name ?? "";

  const profiles = selectRosterProfiles(
    deps.regularsStore.listByChat(chatId).filter((p) => p.userId !== deps.botUserId),
    deps.optedOutUserIds(),
  );
  if (profiles.length === 0) {
    await ctx.reply("Я тут ще нікого до пуття не знаю.", { reply_to_message_id: replyTo });
    return;
  }

  const model = deps.chatSettings.getModel(chatId) ?? deps.model;
  const digestModel = deps.chatSettings.getDigestModel(chatId) ?? deps.digestModel;
  const baseRecord = {
    ts: Date.now(),
    chatId,
    userId,
    userName,
    triggerMsgId: replyTo,
    model,
    weight: 1,
  };

  const globalStatus = deps.llmCallStore.checkGlobalRate(deps.globalDailyCap);
  if (!globalStatus.allowed) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "global_cap" });
    await ctx.reply("На сьогодні досить, до завтра.", { reply_to_message_id: replyTo });
    return;
  }
  const userStatus = deps.llmCallStore.checkUserRate(userId, deps.defaultDailyLimit);
  if (!userStatus.allowed) {
    deps.llmCallStore.record({ ...baseRecord, status: "rate_limited", errorMessage: "user_limit" });
    await ctx.reply("Усе, на сьогодні досить.", { reply_to_message_id: replyTo });
    return;
  }

  // Персона — той самий кешований блок, що й у звичайних відповідях; задача
  // й профілі — змінний хвіст.
  const persona = withSpecialInstructions(
    deps.persona(model, digestModel, deps.chatSettings.getPersona(chatId)),
    deps.instructionStore.list(chatId).map((i) => i.text),
  );
  const system: SystemBlock[] = [
    { type: "text", text: persona, cache_control: { type: "ephemeral" } },
    { type: "text", text: ROSTER_PROMPT },
  ];
  const userMessage = `${userName}: Кицюня, розкажи про учасників\n\nПрофілі:\n\n${renderRosterProfiles(profiles)}`;

  const stopTyping = deps.startTyping(ctx);
  try {
    const reply = await deps.llmClient.reply(system, userMessage, model, ROSTER_MAX_TOKENS);
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
    deps.log.info({ chatId, userId, people: profiles.length, cost }, "roster ok");

    if (reply.stopReason === "max_tokens") {
      deps.log.warn({ chatId, userId, outputTokens: reply.outputTokens }, "roster cut short");
    }
    const text = reply.text.trim() || "Загубила думку, спитай ще раз.";
    // Як і дайджест, у messages не зберігаємо: довгий текст витіснив би контекст.
    await replyInChunks(ctx, text, replyTo);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    deps.llmCallStore.record({ ...baseRecord, status: "error", errorMessage });
    deps.log.error({ err: errorMessage, chatId, userId }, "roster failed");
    await ctx.reply("Щось не вийшло, спробуй пізніше.", { reply_to_message_id: replyTo });
  } finally {
    stopTyping();
  }
}
