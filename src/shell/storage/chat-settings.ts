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
  // Стеля повідомлень у дайджесті. null — дефолт з KYTSUNIA_DIGEST_MAX_COUNT.
  getDigestMaxCount: (chatId: number) => number | null;
  setDigestMaxCount: (chatId: number, max: number, updatedByUserId?: number | null) => void;
  clearDigestMaxCount: (chatId: number) => boolean;
};

export function makeChatSettingsStore(db: Db): ChatSettingsStore {
  const getStmt = db.prepare(
    "SELECT model, persona, digest_max_count FROM chat_settings WHERE chat_id = ?",
  );
  type Column = "model" | "persona" | "digest_max_count";
  const upsert = (column: Column) =>
    db.prepare(
      `INSERT INTO chat_settings (chat_id, ${column}, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         ${column} = excluded.${column},
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    );
  const clear = (column: Column) =>
    db.prepare(
      `UPDATE chat_settings SET ${column} = NULL, updated_at = ?
       WHERE chat_id = ? AND ${column} IS NOT NULL`,
    );
  const setModelStmt = upsert("model");
  const setPersonaStmt = upsert("persona");
  const clearModelStmt = clear("model");
  const clearPersonaStmt = clear("persona");
  const setDigestMaxStmt = upsert("digest_max_count");
  const clearDigestMaxStmt = clear("digest_max_count");

  const get = (chatId: number) =>
    getStmt.get(chatId) as
      | { model: string | null; persona: string | null; digest_max_count: number | null }
      | undefined;

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

    getDigestMaxCount: (chatId) => get(chatId)?.digest_max_count ?? null,
    setDigestMaxCount: (chatId, max, updatedByUserId = null) => {
      setDigestMaxStmt.run(chatId, max, Date.now(), updatedByUserId);
    },
    clearDigestMaxCount: (chatId) => clearDigestMaxStmt.run(Date.now(), chatId).changes > 0,
  };
}
