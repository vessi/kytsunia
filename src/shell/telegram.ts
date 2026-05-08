import type { Context } from "grammy";
import type { MessageInput, MessageKind } from "../core/types.js";

/**
 * Перетворює grammy Context на чистий MessageInput.
 * Повертає null, якщо повідомлення відсутнє або без потрібних полів.
 */
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
