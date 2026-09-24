import type { Db } from "./db.js";

export type ChatSettingsStore = {
  // null — перевизначення немає, працює модель за замовчуванням.
  getModel: (chatId: number) => string | null;
  setModel: (chatId: number, model: string, updatedByUserId?: number | null) => void;
  // true, якщо перевизначення було.
  clearModel: (chatId: number) => boolean;
};

export function makeChatSettingsStore(db: Db): ChatSettingsStore {
  const getStmt = db.prepare("SELECT model FROM chat_settings WHERE chat_id = ?");
  const upsertStmt = db.prepare(
    `INSERT INTO chat_settings (chat_id, model, updated_at, updated_by_user_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       model = excluded.model,
       updated_at = excluded.updated_at,
       updated_by_user_id = excluded.updated_by_user_id`,
  );
  const clearStmt = db.prepare("DELETE FROM chat_settings WHERE chat_id = ? AND model IS NOT NULL");

  return {
    getModel: (chatId) => {
      const row = getStmt.get(chatId) as { model: string | null } | undefined;
      return row?.model ?? null;
    },
    setModel: (chatId, model, updatedByUserId = null) => {
      upsertStmt.run(chatId, model, Date.now(), updatedByUserId);
    },
    clearModel: (chatId) => clearStmt.run(chatId).changes > 0,
  };
}
