import type { Db } from "./db.js";

// Один рядок на чат, поля незалежні: скидання моделі не чіпає персону і навпаки.
export type ChatSettingsStore = {
  // null — перевизначення немає, працює модель за замовчуванням.
  getModel: (chatId: number) => string | null;
  setModel: (chatId: number, model: string, updatedByUserId?: number | null) => void;
  // true, якщо перевизначення було.
  clearModel: (chatId: number) => boolean;
  // null — персона з коду.
  getPersona: (chatId: number) => string | null;
  setPersona: (chatId: number, persona: string, updatedByUserId?: number | null) => void;
  clearPersona: (chatId: number) => boolean;
};

export function makeChatSettingsStore(db: Db): ChatSettingsStore {
  const getStmt = db.prepare("SELECT model, persona FROM chat_settings WHERE chat_id = ?");
  const upsert = (column: "model" | "persona") =>
    db.prepare(
      `INSERT INTO chat_settings (chat_id, ${column}, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         ${column} = excluded.${column},
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    );
  const clear = (column: "model" | "persona") =>
    db.prepare(
      `UPDATE chat_settings SET ${column} = NULL, updated_at = ?
       WHERE chat_id = ? AND ${column} IS NOT NULL`,
    );
  const setModelStmt = upsert("model");
  const setPersonaStmt = upsert("persona");
  const clearModelStmt = clear("model");
  const clearPersonaStmt = clear("persona");

  const get = (chatId: number) =>
    getStmt.get(chatId) as { model: string | null; persona: string | null } | undefined;

  return {
    getModel: (chatId) => get(chatId)?.model ?? null,
    setModel: (chatId, model, updatedByUserId = null) => {
      setModelStmt.run(chatId, model, Date.now(), updatedByUserId);
    },
    clearModel: (chatId) => clearModelStmt.run(Date.now(), chatId).changes > 0,

    getPersona: (chatId) => get(chatId)?.persona ?? null,
    setPersona: (chatId, persona, updatedByUserId = null) => {
      setPersonaStmt.run(chatId, persona, Date.now(), updatedByUserId);
    },
    clearPersona: (chatId) => clearPersonaStmt.run(Date.now(), chatId).changes > 0,
  };
}
