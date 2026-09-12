import type { Message } from "grammy/types";
import type { Db } from "../storage/db.js";

export type ThreadMessage = {
  senderName: string;
  text: string;
};

// Пряма ціль відповіді. Приходить із Telegram, а не з DB: так гілка працює
// навіть коли повідомлення старіше за нашу історію або бот перезапускався.
export type ReplyTarget = {
  messageId: number;
  senderName: string;
  text: string;
};

interface ThreadRow {
  sender_name: string | null;
  text: string | null;
  kind: string;
  reply_to_id: number | null;
  photo_file_id: string | null;
}

function marker(kind: string, hasPhoto: boolean): string {
  if (hasPhoto || kind === "photo") return "[фото]";
  if (kind === "sticker") return "[стікер]";
  if (kind === "animation") return "[гіфка]";
  return "";
}

// Текст рядка гілки: caption/текст з маркером фото попереду, або сам маркер,
// якщо тексту немає. Картинки сюди не їдуть — їх окремо збирає vision.
function describe(text: string, kind: string, hasPhoto: boolean): string {
  const m = marker(kind, hasPhoto);
  const t = text.trim();
  if (t && m) return `${m} ${t}`;
  return t || m;
}

export function replyTargetFromMessage(reply: Message): ReplyTarget {
  const kind = reply.sticker ? "sticker" : reply.animation ? "animation" : "text";
  return {
    messageId: reply.message_id,
    senderName: reply.from?.first_name ?? "",
    text: describe(reply.text ?? reply.caption ?? "", kind, Boolean(reply.photo)),
  };
}

/**
 * Гілка reply-ланцюга, на яку відповідає користувач, від старішого до новішого.
 * Останній елемент — саме те повідомлення, на яке відповіли.
 *
 * Пряма ціль береться з Telegram, глибші кроки — з DB за reply_to_id. Кицюня
 * зберігає власні відповіді з reply_to_id, тож «user → bot → user → bot»
 * розплутується так само, як і для фото. maxDepth рахує всі повідомлення
 * гілки включно з ціллю; 0 вимикає гілку зовсім.
 */
export function collectThread(
  db: Db,
  chatId: number,
  target: ReplyTarget,
  maxDepth: number,
): ThreadMessage[] {
  if (maxDepth <= 0) return [];

  const stmt = db.prepare(`
    SELECT sender_name, text, kind, reply_to_id, photo_file_id
    FROM messages
    WHERE chat_id = ? AND msg_id = ?
  `);

  const newestFirst: ThreadMessage[] = [{ senderName: target.senderName, text: target.text }];

  const targetRow = stmt.get(chatId, target.messageId) as ThreadRow | undefined;
  let currentId = targetRow?.reply_to_id ?? null;

  while (currentId !== null && newestFirst.length < maxDepth) {
    const row = stmt.get(chatId, currentId) as ThreadRow | undefined;
    if (!row) break;
    const text = describe(row.text ?? "", row.kind, row.photo_file_id !== null);
    if (text) newestFirst.push({ senderName: row.sender_name ?? "", text });
    currentId = row.reply_to_id;
  }

  return newestFirst.reverse();
}
