import type { Db } from "./db.js";

export type DigestRecord = {
  chatId: number;
  ts: number;
  messageId: number;
  fromMsgId: number;
  toMsgId: number;
  count: number;
  text: string;
};

export type DigestStore = {
  record: (d: DigestRecord) => void;
  // Найсвіжіший дайджест чату не старший за sinceTs, вікно якого перетинається
  // з [fromMsgId, toMsgId].
  latestOverlapping: (
    chatId: number,
    fromMsgId: number,
    toMsgId: number,
    sinceTs: number,
  ) => DigestRecord | null;
};

interface Row {
  chat_id: number;
  ts: number;
  message_id: number;
  from_msg_id: number;
  to_msg_id: number;
  count: number;
  text: string;
}

export function makeDigestStore(db: Db): DigestStore {
  const insertStmt = db.prepare(
    `INSERT INTO digests (chat_id, ts, message_id, from_msg_id, to_msg_id, count, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const overlapStmt = db.prepare(
    `SELECT chat_id, ts, message_id, from_msg_id, to_msg_id, count, text FROM digests
     WHERE chat_id = ? AND ts >= ? AND from_msg_id <= ? AND to_msg_id >= ?
     ORDER BY ts DESC LIMIT 1`,
  );
  return {
    record: (d) => {
      insertStmt.run(d.chatId, d.ts, d.messageId, d.fromMsgId, d.toMsgId, d.count, d.text);
    },
    latestOverlapping: (chatId, fromMsgId, toMsgId, sinceTs) => {
      const r = overlapStmt.get(chatId, sinceTs, toMsgId, fromMsgId) as Row | undefined;
      if (!r) return null;
      return {
        chatId: r.chat_id,
        ts: r.ts,
        messageId: r.message_id,
        fromMsgId: r.from_msg_id,
        toMsgId: r.to_msg_id,
        count: r.count,
        text: r.text,
      };
    },
  };
}
