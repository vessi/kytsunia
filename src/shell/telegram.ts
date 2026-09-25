import { type Context, InputFile } from "grammy";
import type { Action, MessageInput, MessageKind } from "../core/types.js";
import type { InvokeDigestDeps } from "./llm/digest.js";
import { invokeDigest, truncateForTelegram } from "./llm/digest.js";
import type { InvokeLlmDeps } from "./llm/invoke.js";
import { invokeLlmReply } from "./llm/invoke.js";
import { modelChoicesHelp, resolveModel } from "./llm/models.js";
import { PERSONA_PROMPT } from "./llm/persona.js";
import type { ProfileRefreshDeps, RefreshOptions } from "./llm/profile-refresh.js";
import { refreshProfiles } from "./llm/profile-refresh.js";
import type { InvokeRosterDeps } from "./llm/roster.js";
import { invokeRoster } from "./llm/roster.js";
import type { ChatSettingsStore } from "./storage/chat-settings.js";
import type { IgnoredUsersStore } from "./storage/ignored.js";
import type { InstructionStore } from "./storage/instructions.js";
import type { LlmCallStore } from "./storage/llm-calls.js";
import type { OptOutsStore } from "./storage/opt-outs.js";
import type { RegularsStore } from "./storage/regulars.js";
import type { DynamicRuleStore } from "./storage/rules.js";
import { formatKyivDate, startOfKyivDay } from "./time.js";
import { formatUsageReport } from "./usage-report.js";

export type ExecuteDeps = {
  insults: string[];
  rng: () => number;
  dynamicRuleStore: DynamicRuleStore;
  llmCallStore: LlmCallStore;
  defaultDailyLimit: number;
  invokeLlmDeps: InvokeLlmDeps;
  invokeDigestDeps: InvokeDigestDeps;
  invokeRosterDeps: InvokeRosterDeps;
  optOutsStore: OptOutsStore;
  regularsStore: RegularsStore;
  ignoredUsersStore: IgnoredUsersStore;
  instructionStore: InstructionStore;
  chatSettings: ChatSettingsStore;
  defaultModel: string;
  defaultDigestModel: string;
  // Глобальна стеля повідомлень у дайджесті; чат може замінити її будь-якою.
  digestMaxCount: number;
  profileRefresh: ProfileRefreshDeps;
  profileRefreshOptions: Pick<RefreshOptions, "threshold" | "days" | "limitMessages" | "model">;
  // Чати, де оновлення профілів уже йде: другий запит поспіль не запускаємо.
  profileRefreshInProgress: Set<number>;
};

export function toMessageInput(ctx: Context): MessageInput | null {
  const m = ctx.message;
  if (!m) return null;

  const text = m.text ?? m.caption ?? "";
  const senderName = m.from?.first_name ?? "";
  const kind = detectKind(m);

  // Telegram віддає фото в кількох розмірах; беремо найбільший — для зору модель
  // отримає максимум деталей, ціна токенів та сама.
  const largestPhoto = m.photo?.at(-1);
  const replyLargestPhoto = m.reply_to_message?.photo?.at(-1);

  const reply = m.reply_to_message;
  const replyTo = reply
    ? {
        messageId: reply.message_id,
        authorId: reply.from?.id ?? 0,
        authorName: reply.from?.first_name ?? "",
        ...(reply.text ? { text: reply.text } : {}),
        ...(reply.animation ? { animationFileId: reply.animation.file_id } : {}),
        ...(reply.sticker ? { stickerFileId: reply.sticker.file_id } : {}),
        ...(replyLargestPhoto
          ? {
              photoFileId: replyLargestPhoto.file_id,
              photoUniqueId: replyLargestPhoto.file_unique_id,
            }
          : {}),
        ...(reply.media_group_id ? { mediaGroupId: reply.media_group_id } : {}),
      }
    : undefined;

  const forwardOrigin =
    m.forward_origin?.type === "channel"
      ? { kind: "channel" as const, chatId: m.forward_origin.chat.id }
      : undefined;

  return {
    text,
    messageId: m.message_id,
    chatId: m.chat.id,
    senderId: m.from?.id ?? 0,
    senderName,
    ts: m.date * 1000,
    kind,
    ...(replyTo ? { replyTo } : {}),
    ...(forwardOrigin ? { forwardOrigin } : {}),
    ...(largestPhoto
      ? { photoFileId: largestPhoto.file_id, photoUniqueId: largestPhoto.file_unique_id }
      : {}),
    ...(m.media_group_id ? { mediaGroupId: m.media_group_id } : {}),
  };
}

/**
 * Повідомлення ігнорованого зберігаємо, але без посилань на фото: текст
 * потрібен контексту й дайджесту (вийняти людину з розмови — дайджест
 * попливе), а картинки моделі бачити не треба. Без photo_file_id рядок не
 * підхоплять ні TTL-fallback, ні альбом, ні прохід по ланцюжку відповідей.
 */
export function withoutPhotos(input: MessageInput): MessageInput {
  const { photoFileId: _f, photoUniqueId: _u, mediaGroupId: _g, ...rest } = input;
  return rest;
}

function detectKind(m: NonNullable<Context["message"]>): MessageKind {
  if (m.forward_origin) return "forward";
  if (m.animation) return "animation";
  if (m.sticker) return "sticker";
  if (m.photo) return "photo";
  if (m.text) return "text";
  return "other";
}

export async function executeActions(
  actions: Action[],
  ctx: Context,
  deps: ExecuteDeps,
): Promise<void> {
  for (const a of actions) {
    await executeOne(a, ctx, deps);
  }
}

async function executeOne(action: Action, ctx: Context, deps: ExecuteDeps): Promise<void> {
  switch (action.kind) {
    case "react":
      await ctx.react(action.emoji as Parameters<typeof ctx.react>[0]);
      return;

    case "reply_text":
      await ctx.reply(action.text, {
        ...(action.replyTo !== undefined ? { reply_to_message_id: action.replyTo } : {}),
      });
      return;

    case "send_photo_url":
      await ctx.api.sendPhoto(action.chatId, new InputFile(new URL(action.url), action.filename));
      return;

    case "send_animation":
      await ctx.api.sendAnimation(action.chatId, action.fileId, {
        ...(action.replyTo !== undefined ? { reply_to_message_id: action.replyTo } : {}),
      });
      return;

    case "send_sticker":
      await ctx.api.sendSticker(action.chatId, action.fileId, {
        ...(action.replyTo !== undefined ? { reply_to_message_id: action.replyTo } : {}),
      });
      return;

    case "send_message_to_chat":
      await ctx.api.sendMessage(action.chatId, action.text);
      return;

    case "discipline_with_random_insult": {
      if (deps.insults.length === 0) return;
      const idx = Math.floor(deps.rng() * deps.insults.length);
      const insult = deps.insults[idx];
      if (!insult) return;
      await ctx.reply(insult, { reply_to_message_id: action.replyTo });
      return;
    }
    case "register_dynamic_rule":
      deps.dynamicRuleStore.add(action.spec);
      return;
    case "forget_dynamic_rule":
      deps.dynamicRuleStore.remove(action.pattern);
      return;
    case "report_user_rate_status": {
      const status = deps.llmCallStore.checkUserRate(action.userId, deps.defaultDailyLimit);
      let text: string;
      if (status.limit === null) {
        text = "У тебе безліміт.";
      } else if (status.allowed) {
        const left = status.limit - status.used;
        text = `Ще ${left} з ${status.limit} на сьогодні.`;
      } else {
        text = "Усе, на сьогодні нуль. Завтра.";
      }
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "report_usage": {
      const DAY_MS = 86_400_000;
      const todayStart = startOfKyivDay();
      // days=1 означає «лише сьогодні»: період починається з початку дня.
      const sinceTs = todayStart - (action.days - 1) * DAY_MS;
      const text = formatUsageReport({
        days: action.days,
        sinceTs,
        period: deps.llmCallStore.usageSummary(sinceTs),
        today: deps.llmCallStore.usageSummary(todayStart),
        currentChatId: ctx.chat?.id ?? 0,
      });
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "add_special_instruction": {
      const saved = deps.instructionStore.add(action.chatId, action.text, ctx.from?.id ?? null);
      await ctx.reply(`Записала інструкцію #${saved.id}.`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "list_special_instructions": {
      const all = deps.instructionStore.list(action.chatId);
      const text =
        all.length === 0
          ? "У цьому чаті спеціальних інструкцій немає."
          : all.map((i) => `#${i.id} · ${formatKyivDate(i.createdAt)}\n${i.text}`).join("\n\n");
      await ctx.reply(truncateForTelegram(text), { reply_to_message_id: action.replyTo });
      return;
    }
    case "remove_special_instruction": {
      const removed = deps.instructionStore.remove(action.chatId, action.id);
      const text = removed ? `Забула інструкцію #${action.id}.` : "Такої інструкції немає.";
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "show_chat_model": {
      const override = deps.chatSettings.getModel(action.chatId);
      const text = override
        ? `Модель у цьому чаті: ${override}. За замовчуванням була б ${deps.defaultModel}.`
        : `Модель у цьому чаті: ${deps.defaultModel} (за замовчуванням).`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "set_chat_model": {
      const model = resolveModel(action.model);
      if (!model) {
        await ctx.reply(`Не знаю такої моделі. ${modelChoicesHelp()}`, {
          reply_to_message_id: action.replyTo,
        });
        return;
      }
      deps.chatSettings.setModel(action.chatId, model, ctx.from?.id ?? null);
      await ctx.reply(`Тепер у цьому чаті відповідаю через ${model}.`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "reset_chat_model": {
      const had = deps.chatSettings.clearModel(action.chatId);
      const text = had
        ? `Повернула модель за замовчуванням: ${deps.defaultModel}.`
        : `Тут і так модель за замовчуванням: ${deps.defaultModel}.`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "show_chat_persona": {
      const override = deps.chatSettings.getPersona(action.chatId);
      const text = override
        ? `Персона цього чату (задана адміном):\n\n${override}`
        : `Персона за замовчуванням (з коду):\n\n${PERSONA_PROMPT}`;
      await ctx.reply(truncateForTelegram(text), { reply_to_message_id: action.replyTo });
      return;
    }
    case "set_chat_persona": {
      deps.chatSettings.setPersona(action.chatId, action.text, ctx.from?.id ?? null);
      await ctx.reply("Записала. Тепер у цьому чаті я така.", {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "reset_chat_persona": {
      const had = deps.chatSettings.clearPersona(action.chatId);
      const text = had ? "Повернула персону з коду." : "Тут і так персона з коду.";
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "show_digest_model": {
      const override = deps.chatSettings.getDigestModel(action.chatId);
      const text = override
        ? `Дайджест у цьому чаті пише ${override}. За замовчуванням була б ${deps.defaultDigestModel}.`
        : `Дайджест у цьому чаті пише ${deps.defaultDigestModel} (за замовчуванням).`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "set_digest_model": {
      const model = resolveModel(action.model);
      if (!model) {
        await ctx.reply(`Не знаю такої моделі. ${modelChoicesHelp()}`, {
          reply_to_message_id: action.replyTo,
        });
        return;
      }
      deps.chatSettings.setDigestModel(action.chatId, model, ctx.from?.id ?? null);
      await ctx.reply(`Тепер дайджест у цьому чаті пише ${model}.`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "reset_digest_model": {
      const had = deps.chatSettings.clearDigestModel(action.chatId);
      const text = had
        ? `Повернула модель дайджесту за замовчуванням: ${deps.defaultDigestModel}.`
        : `Тут і так модель дайджесту за замовчуванням: ${deps.defaultDigestModel}.`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "show_digest_max": {
      const override = deps.chatSettings.getDigestMaxCount(action.chatId);
      const max = override ?? deps.digestMaxCount;
      const origin = override === null ? "за замовчуванням" : "задано для чату";
      await ctx.reply(`Дайджест у цьому чаті бере до ${max} повідомлень (${origin}).`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "set_digest_max": {
      deps.chatSettings.setDigestMaxCount(action.chatId, action.max, ctx.from?.id ?? null);
      await ctx.reply(`Тепер дайджест у цьому чаті бере до ${action.max} повідомлень.`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "reset_digest_max": {
      const had = deps.chatSettings.clearDigestMaxCount(action.chatId);
      const text = had
        ? `Повернула стелю за замовчуванням: ${deps.digestMaxCount} повідомлень.`
        : `Тут і так стеля за замовчуванням: ${deps.digestMaxCount} повідомлень.`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "ignore_user": {
      const added = deps.ignoredUsersStore.add(
        action.userId,
        action.userName,
        ctx.from?.id ?? null,
      );
      const name = action.userName || String(action.userId);
      const text = added ? `Добре, ${name} для мене більше не існує.` : `${name} і так у списку.`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "unignore_user": {
      const removed = deps.ignoredUsersStore.remove(action.userId);
      const name = action.userName || String(action.userId);
      const text = removed ? `Гаразд, ${name} знову чую.` : `${name} я і так не ігнорувала.`;
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "list_ignored": {
      const all = deps.ignoredUsersStore.list();
      const text =
        all.length === 0
          ? "Нікого не ігнорую."
          : all.map((u) => `${u.userName || "?"} (${u.userId})`).join("\n");
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "refresh_profiles": {
      if (deps.profileRefreshInProgress.has(action.chatId)) {
        await ctx.reply("Уже оновлюю, зачекай.", { reply_to_message_id: action.replyTo });
        return;
      }
      // Десяток викликів моделі — це хвилина. Не тримаємо чергу апдейтів:
      // відповідаємо одразу, а результат досилаємо, коли закінчимо.
      deps.profileRefreshInProgress.add(action.chatId);
      await ctx.reply("Оновлюю профілі цього чату, напишу, як закінчу.", {
        reply_to_message_id: action.replyTo,
      });
      const api = ctx.api;
      void refreshProfiles(deps.profileRefresh, {
        ...deps.profileRefreshOptions,
        chatId: action.chatId,
        requestedByUserId: ctx.from?.id ?? 0,
        requestedByName: ctx.from?.first_name ?? "",
      })
        .then((r) => {
          const parts = [
            r.processed === 0
              ? "Оновлювати нема кого: постійних учасників не набралось."
              : `Оновила профілі: ${r.processed}.`,
          ];
          if (r.failed > 0) parts.push(`Не вийшло: ${r.failed}.`);
          if (r.skipped > 0) parts.push(`Пропустила (просили не профайлити): ${r.skipped}.`);
          if (r.filtered > 0) parts.push(`Відкинула через OPSEC: ${r.filtered}.`);
          if (r.processed > 0) parts.push(`Коштувало $${r.totalCostUsd.toFixed(3)}.`);
          return api.sendMessage(action.chatId, parts.join(" "), {
            reply_parameters: { message_id: action.replyTo },
          });
        })
        .catch((err) => {
          deps.profileRefresh.log.error(
            { err: err instanceof Error ? err.message : err, chatId: action.chatId },
            "profile refresh failed",
          );
          return api.sendMessage(action.chatId, "Оновлення профілів зламалось, глянь логи.");
        })
        .finally(() => deps.profileRefreshInProgress.delete(action.chatId));
      return;
    }
    case "opt_out_profile": {
      if (deps.optOutsStore.isOptedOut(action.userId)) {
        await ctx.reply("Я і так тебе не профайлю.", { reply_to_message_id: action.replyTo });
        return;
      }
      deps.optOutsStore.optOut(action.userId);
      const removed = deps.regularsStore.removeAllForUser(action.userId);
      const note = removed > 0 ? " І стерла, що знала." : "";
      await ctx.reply(`Окей, забула.${note} Більше не буду тебе вивчати.`, {
        reply_to_message_id: action.replyTo,
      });
      return;
    }
    case "opt_in_profile": {
      const wasOptedOut = deps.optOutsStore.optIn(action.userId);
      const text = wasOptedOut
        ? "Добре, можу знову. Профайл збереться, коли назбирається повідомлень."
        : "Я і так тебе можу профайлити.";
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "report_opt_out_status": {
      const optedOut = deps.optOutsStore.isOptedOut(action.userId);
      const text = optedOut
        ? "Ні, ти просив забути. Скажи «запамʼятай мене», щоб увімкнути назад."
        : "Так, профайлю. Скажи «забудь мене», якщо не хочеш.";
      await ctx.reply(text, { reply_to_message_id: action.replyTo });
      return;
    }
    case "invoke_llm_reply":
      await invokeLlmReply(ctx, action.replyTo, deps.invokeLlmDeps);
      return;

    case "invoke_web_search":
      await invokeLlmReply(ctx, action.replyTo, deps.invokeLlmDeps, {
        search: { query: action.query },
      });
      return;

    case "invoke_digest":
      await invokeDigest(ctx, action.replyTo, action.count, deps.invokeDigestDeps);
      return;

    case "invoke_roster":
      await invokeRoster(ctx, action.replyTo, deps.invokeRosterDeps);
      return;
  }
}
