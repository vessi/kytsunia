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
      text, kind, forward_chat_id,
      photo_file_id, photo_unique_id, media_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.photoFileId ?? null,
      input.photoUniqueId ?? null,
      input.mediaGroupId ?? null,
    );
  };
}

export type RecentMessageRow = {
  ts: number;
  senderId: number;
  senderName: string;
  text: string;
  kind: string;
  // Для альбому — масив з кількома елементами в порядку msg_id (тобто ts ASC).
  // Для одиночного фото — один елемент. Для тексту без фото — порожній масив.
  photos: ReadonlyArray<{ fileId: string; uniqueId: string }>;
  mediaGroupId: string | null;
};

interface RawRow {
  ts: number;
  msg_id: number;
  sender_id: number;
  sender_name: string;
  text: string;
  kind: string;
  photo_file_id: string | null;
  photo_unique_id: string | null;
  media_group_id: string | null;
}

/**
 * Повертає до limit «логічних» повідомлень. Фото без caption теж рахуються.
 *
 * Альбоми Telegram приходять як N окремих update-ів з одним media_group_id,
 * тільки на одному з них є caption. Тут вони сходяться в одне повідомлення з
 * масивом photos[]; sender/text/ts беруться з найранішого запису групи (caption
 * зазвичай на ньому). Інші учасники альбому не «займають слот» у LIMIT.
 */
export function getRecentMessages(
  db: Db,
  chatId: number,
  limit: number,
  excludeMsgId?: number,
): RecentMessageRow[] {
  // Беремо «лідерів» альбомів і одинаків. Лідер альбому — рядок з мінімальним
  // msg_id у групі: саме на ньому зазвичай caption.
  // Беремо з запасом і фільтруємо в JS, бо сам LIMIT по сирих рядках включав би
  // фото-сіблінгів і обрізав би текст.
  const rawStmt = db.prepare(`
    SELECT ts, msg_id, sender_id, sender_name, text, kind,
           photo_file_id, photo_unique_id, media_group_id
    FROM messages
    WHERE chat_id = ?
      AND msg_id != ?
      AND (text != '' OR photo_file_id IS NOT NULL)
    ORDER BY ts DESC
    LIMIT ?
  `);

  // Запас в 5x грубо покриває альбоми до 5 фото; при більших — другий проход добере.
  const fetchLimit = Math.max(limit * 5, limit + 20);
  const raw = rawStmt.all(chatId, excludeMsgId ?? 0, fetchLimit) as RawRow[];

  // Згортаємо в логічні повідомлення: по media_group_id (для альбомів) або по
  // msg_id (для одинаків).
  const groups = new Map<string, RawRow[]>();
  for (const r of raw) {
    const key = r.media_group_id ? `g:${r.media_group_id}` : `m:${r.msg_id}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  // Сортуємо логічні повідомлення за ts найранішого члена і беремо top N
  // (DESC у часі, бо дальше реверс).
  const logicals = [...groups.values()].sort((a, b) => {
    const aMin = Math.min(...a.map((x) => x.ts));
    const bMin = Math.min(...b.map((x) => x.ts));
    return bMin - aMin;
  });
  const topN = logicals.slice(0, limit);

  // Якщо в LIMIT потрапив альбом, у якого не всі фото — добираємо сіблінгів
  // другим запитом (рідкісний edge case при дуже великих альбомах).
  const partialGroupIds = topN
    .filter((g) => g[0]?.media_group_id)
    .map((g) => g[0]?.media_group_id as string);

  if (partialGroupIds.length > 0) {
    const placeholders = partialGroupIds.map(() => "?").join(",");
    const siblingStmt = db.prepare(`
      SELECT ts, msg_id, sender_id, sender_name, text, kind,
             photo_file_id, photo_unique_id, media_group_id
      FROM messages
      WHERE chat_id = ? AND media_group_id IN (${placeholders})
      ORDER BY msg_id ASC
    `);
    const siblings = siblingStmt.all(chatId, ...partialGroupIds) as RawRow[];

    const fullGroups = new Map<string, RawRow[]>();
    for (const r of siblings) {
      const id = r.media_group_id as string;
      const arr = fullGroups.get(id);
      if (arr) arr.push(r);
      else fullGroups.set(id, [r]);
    }
    // Замінюємо часткові групи в topN на повні (зберігаючи порядок).
    for (let i = 0; i < topN.length; i++) {
      const cur = topN[i];
      if (!cur) continue;
      const head = cur[0];
      if (!head?.media_group_id) continue;
      const full = fullGroups.get(head.media_group_id);
      if (full) topN[i] = full;
    }
  }

  // Кожна група → один RecentMessageRow. Сортування фото по msg_id ASC.
  const rows = topN.map<RecentMessageRow>((group) => {
    const sorted = [...group].sort((a, b) => a.msg_id - b.msg_id);
    // Беремо метадані з рядка з caption, якщо є; інакше з найранішого.
    const withText = sorted.find((r) => r.text && r.text !== "") ?? sorted[0];
    const head = withText ?? sorted[0];
    if (!head) {
      throw new Error("empty message group");
    }
    const photos = sorted
      .filter((r) => r.photo_file_id && r.photo_unique_id)
      .map((r) => ({
        fileId: r.photo_file_id as string,
        uniqueId: r.photo_unique_id as string,
      }));

    return {
      ts: head.ts,
      senderId: head.sender_id,
      senderName: head.sender_name,
      text: head.text ?? "",
      kind: head.kind,
      photos,
      mediaGroupId: head.media_group_id,
    };
  });

  // Reverse: chronological order (oldest → newest), як було раніше.
  return rows.reverse();
}
