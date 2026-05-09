import type { MessageInput } from "../../core/types.js";
import type { Db } from "./db.js";

export type MessageAppender = (input: MessageInput) => void;

/**
 * Створює функцію appendMessage з cached prepared statement.
 * INSERT OR IGNORE: при колізії (chat_id, msg_id) залишаємо першу версію.
 * Edits ловляться через окремий 'edited_message' event, не дублюються тут.
 */
export function makeMessageAppender(db: Db): MessageAppender {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      chat_id, msg_id, ts, sender_id, sender_name,
      reply_to_id, reply_to_author_id, reply_to_author_name,
      text, kind, forward_chat_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return (input) => {
    stmt.run(
      input.chatId,
      input.messageId,
      input.ts,
      input.senderId,
      input.senderName,
      input.replyTo?.messageId ?? null,
      input.replyTo?.authorId ?? null,
      input.replyTo?.authorName ?? null,
      input.text,
      input.kind,
      input.forwardOrigin?.chatId ?? null,
    );
  };
}

export type RecentMessageRow = {
  ts: number;
  senderId: number;
  senderName: string;
  text: string;
  kind: string;
};

export function getRecentMessages(
  db: Db,
  chatId: number,
  limit: number,
  excludeMsgId?: number,
): RecentMessageRow[] {
  const stmt = db.prepare(`
    SELECT ts, sender_id, sender_name, text, kind
    FROM messages
    WHERE chat_id = ? AND text != '' AND msg_id != ?
    ORDER BY ts DESC
    LIMIT ?
  `);

  const rows = stmt.all(chatId, excludeMsgId ?? 0, limit) as Array<{
    ts: number;
    sender_id: number;
    sender_name: string;
    text: string;
    kind: string;
  }>;

  return rows
    .map((r) => ({
      ts: r.ts,
      senderId: r.sender_id,
      senderName: r.sender_name,
      text: r.text,
      kind: r.kind,
    }))
    .reverse();
}
