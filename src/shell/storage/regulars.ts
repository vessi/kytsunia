import type { Db } from "./db.js";

export type RegularProfile = {
  userId: number;
  chatId: number;
  displayName: string | null;
  profile: string;
  messageCount: number;
  lastMessageTs: number | null;
  generatedAt: number;
  manualNotes: string | null;
  // З таблиці users; null, якщо людина без @username або ще не писала після деплою.
  username?: string | null;
};

export type UpsertInput = Omit<RegularProfile, "generatedAt" | "manualNotes">;

export type RegularsStore = {
  upsert: (input: UpsertInput) => void;
  get: (userId: number, chatId: number) => RegularProfile | null;
  list: () => RegularProfile[];
  listByChat: (chatId: number) => RegularProfile[];
  remove: (userId: number, chatId: number) => boolean;
  removeAllForUser: (userId: number) => number;
  setManualNotes: (userId: number, chatId: number, notes: string | null) => void;
};

interface RegularRow {
  user_id: number;
  chat_id: number;
  display_name: string | null;
  profile: string;
  message_count: number;
  last_message_ts: number | null;
  generated_at: number;
  manual_notes: string | null;
  username?: string | null;
}

function rowToProfile(row: RegularRow): RegularProfile {
  return {
    userId: row.user_id,
    chatId: row.chat_id,
    displayName: row.display_name,
    profile: row.profile,
    messageCount: row.message_count,
    lastMessageTs: row.last_message_ts,
    generatedAt: row.generated_at,
    manualNotes: row.manual_notes,
    username: row.username ?? null,
  };
}

export function makeRegularsStore(db: Db): RegularsStore {
  const upsertStmt = db.prepare(`
    INSERT INTO regulars (
      user_id, chat_id, display_name, profile, message_count, last_message_ts, generated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
      display_name = excluded.display_name,
      profile = excluded.profile,
      message_count = excluded.message_count,
      last_message_ts = excluded.last_message_ts,
      generated_at = excluded.generated_at
  `);

  // LEFT JOIN users: хендл живе там, бо профіль — на чат, а хендл — на людину.
  const SELECT = `SELECT r.*, u.username FROM regulars r LEFT JOIN users u ON u.user_id = r.user_id`;
  const getStmt = db.prepare(`${SELECT} WHERE r.user_id = ? AND r.chat_id = ?`);
  const listStmt = db.prepare(`${SELECT} ORDER BY r.generated_at DESC`);
  const listByChatStmt = db.prepare(`${SELECT} WHERE r.chat_id = ? ORDER BY r.message_count DESC`);
  const deleteStmt = db.prepare("DELETE FROM regulars WHERE user_id = ? AND chat_id = ?");
  const deleteAllForUserStmt = db.prepare("DELETE FROM regulars WHERE user_id = ?");
  const updateNotesStmt = db.prepare(
    "UPDATE regulars SET manual_notes = ? WHERE user_id = ? AND chat_id = ?",
  );

  return {
    upsert: (input) => {
      upsertStmt.run(
        input.userId,
        input.chatId,
        input.displayName,
        input.profile,
        input.messageCount,
        input.lastMessageTs,
        Date.now(),
      );
    },

    get: (userId, chatId) => {
      const row = getStmt.get(userId, chatId) as RegularRow | undefined;
      return row ? rowToProfile(row) : null;
    },

    list: () => {
      const rows = listStmt.all() as RegularRow[];
      return rows.map(rowToProfile);
    },

    listByChat: (chatId) => {
      const rows = listByChatStmt.all(chatId) as RegularRow[];
      return rows.map(rowToProfile);
    },

    remove: (userId, chatId) => {
      const result = deleteStmt.run(userId, chatId);
      return result.changes > 0;
    },

    removeAllForUser: (userId) => {
      const result = deleteAllForUserStmt.run(userId);
      return result.changes;
    },

    setManualNotes: (userId, chatId, notes) => {
      updateNotesStmt.run(notes, userId, chatId);
    },
  };
}
