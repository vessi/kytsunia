import { type Context, InputFile } from "grammy";
import type { Action, MessageInput, MessageKind } from "../core/types.js";
import type { InvokeLlmDeps } from "./llm/invoke.js";
import { invokeLlmReply } from "./llm/invoke.js";
import type { LlmCallStore } from "./storage/llm-calls.js";
import type { DynamicRuleStore } from "./storage/rules.js";

export type ExecuteDeps = {
  insults: string[];
  rng: () => number;
  dynamicRuleStore: DynamicRuleStore;
  llmCallStore: LlmCallStore;
  defaultDailyLimit: number;
  invokeLlmDeps: InvokeLlmDeps;
};

export function toMessageInput(ctx: Context): MessageInput | null {
  const m = ctx.message;
  if (!m) return null;

  const text = m.text ?? m.caption ?? "";
  const senderName = m.from?.first_name ?? "";
  const kind = detectKind(m);

  const reply = m.reply_to_message;
  const replyTo = reply
    ? {
        messageId: reply.message_id,
        authorId: reply.from?.id ?? 0,
        authorName: reply.from?.first_name ?? "",
        ...(reply.text ? { text: reply.text } : {}),
        ...(reply.animation ? { animationFileId: reply.animation.file_id } : {}),
        ...(reply.sticker ? { stickerFileId: reply.sticker.file_id } : {}),
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
  };
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
    case "invoke_llm_reply":
      await invokeLlmReply(ctx, action.replyTo, deps.invokeLlmDeps);
      return;
  }
}
