import type { Context } from "grammy";
import type { Logger } from "../logger.js";
import type { AbuseStore } from "../storage/abuse.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import type { LlmClient } from "./anthropic.js";
import { calculateCost } from "./pricing.js";

/**
 * Класифікатор образ на адресу бота. У цих чатах «ти дурна» — розминка, а
 * персона на таке парирує, тож поріг високий: лише злісне й принизливе.
 */
export const ABUSE_PROMPT = `Ти оцінюєш одне повідомлення з українського групового чату, у якому є бот-кицька на імʼя Кицюня. Чат грубуватий, з матюками й стьобом, бот сам snarkуватий і на підколи відповідає підколами. Це норма.

Спершу вирішуй, кому адресоване повідомлення. Воно могло потрапити до тебе лише тому, що є відповіддю на репліку Кицюні або згадує її, але говорити може з іншою людиною в треді, цитувати когось, переказувати, жартувати між собою. Усе, що адресоване не Кицюні, — OK, навіть якщо грубе чи з погрозами на адресу людей: це не твоя справа тут. Якщо незрозуміло, кому адресовано, — OK.

Абʼюз — це лише злісне, принизливе або жорстоке ставлення саме до Кицюні без приводу: образи з ненавистю, приниження гідності, погрози їй, повторюване цькування її, сексуалізовані образи на її адресу. «Ти дурна», «тупа машина», «замовкни», лайка в тексті, критика її відповідей, жарти над нею, провокації заради реакції — НЕ абʼюз.

Відповідай рівно двома рядками:
перший — ABUSE або OK;
другий — одне речення чому, українською.`;

const ABUSE_MAX_TOKENS = 120;

export type AbuseVerdict = { abuse: boolean; reason: string };

export function parseVerdict(text: string): AbuseVerdict {
  const [first = "", ...rest] = text.trim().split("\n");
  const abuse = first.trim().toUpperCase().startsWith("ABUSE");
  return { abuse, reason: rest.join(" ").trim() || first.trim() };
}

export type AbuseGuardDeps = {
  enabled: boolean;
  llmClient: LlmClient;
  llmCallStore: LlmCallStore;
  store: AbuseStore;
  model: string;
  // Удар, на якому прилітає тиждень, і удар, на якому — назавжди.
  weekAt: number;
  foreverAt: number;
  banMs: number;
  now: () => number;
  log: Logger;
};

export type AbuseInput = {
  chatId: number;
  userId: number;
  userName: string;
  msgId: number;
  text: string;
  // На що відповідає повідомлення: класифікатору це головна підказка, кому
  // адресовано. authorIsBot — відповідь саме на репліку Кицюні.
  replyTo?: { authorName: string; authorIsBot: boolean; text: string };
  // Кілька останніх повідомлень чату, рядками «Імʼя: текст».
  recent?: readonly string[];
};

export function renderAbuseInput(input: AbuseInput): string {
  const parts: string[] = [];
  if (input.recent && input.recent.length > 0) {
    parts.push(`Останні повідомлення чату:\n${input.recent.join("\n")}`);
  }
  if (input.replyTo) {
    const who = input.replyTo.authorIsBot ? "Кицюня (бот)" : input.replyTo.authorName;
    parts.push(`Повідомлення є відповіддю на репліку ${who}: «${input.replyTo.text}»`);
  } else {
    parts.push("Повідомлення ні на що не відповідає.");
  }
  parts.push(`Повідомлення від ${input.userName}: «${input.text}»`);
  return parts.join("\n\n");
}

export type AbuseGuard = {
  // "ok" — відповідати як завжди; "banned" — відповідь уже дано, модель не кликати.
  check: (ctx: Context, input: AbuseInput) => Promise<"ok" | "banned">;
};

export function makeAbuseGuard(deps: AbuseGuardDeps): AbuseGuard {
  return {
    check: async (ctx, input) => {
      if (!deps.enabled || !input.text.trim()) return "ok";
      const record = {
        ts: deps.now(),
        chatId: input.chatId,
        userId: input.userId,
        userName: input.userName,
        triggerMsgId: input.msgId,
        model: deps.model,
        weight: 0,
      };
      let verdict: AbuseVerdict;
      try {
        const reply = await deps.llmClient.reply(
          ABUSE_PROMPT,
          renderAbuseInput(input),
          deps.model,
          ABUSE_MAX_TOKENS,
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
        verdict = parseVerdict(reply.text);
      } catch (err) {
        // Класифікатор упав — не караємо й не блокуємо відповідь.
        const errorMessage = err instanceof Error ? err.message : String(err);
        deps.llmCallStore.record({ ...record, status: "error", errorMessage });
        deps.log.warn({ err: errorMessage, userId: input.userId }, "abuse check failed");
        return "ok";
      }
      if (!verdict.abuse) return "ok";

      const strikes = deps.store.addStrike({
        userId: input.userId,
        chatId: input.chatId,
        msgId: input.msgId,
        ts: deps.now(),
        reason: verdict.reason,
      });
      deps.log.warn(
        { userId: input.userId, chatId: input.chatId, strikes, reason: verdict.reason },
        "abuse strike",
      );
      if (strikes >= deps.foreverAt) {
        deps.store.setBan({
          userId: input.userId,
          userName: input.userName,
          since: deps.now(),
          until: null,
          strikes,
        });
        await ctx.reply(
          `${strikes}-й раз. Усе, для мене ти більше не існуєш. Єдине, що ще можеш — «Кицюня, забудь мене».`,
          { reply_to_message_id: input.msgId },
        );
        return "banned";
      }
      if (strikes === deps.weekAt) {
        deps.store.setBan({
          userId: input.userId,
          userName: input.userName,
          since: deps.now(),
          until: deps.now() + deps.banMs,
          strikes,
        });
        await ctx.reply(
          `${strikes}-й раз. Тиждень я тебе не чую. Ще ${deps.foreverAt - strikes} — і назавжди.`,
          { reply_to_message_id: input.msgId },
        );
        return "banned";
      }
      // Перші удари — без коментаря: відповідаємо як завжди, персона й так парирує.
      return "ok";
    },
  };
}
