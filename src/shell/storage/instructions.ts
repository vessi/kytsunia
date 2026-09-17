import type { Db } from "./db.js";

export type SpecialInstruction = {
  id: number;
  chatId: number;
  text: string;
  createdAt: number;
};

// Інструкції живуть у скоупі чату: список і видалення завжди по chatId, тож
// id з одного чату не зачепить інструкцію іншого.
export type InstructionStore = {
  // Від старішої до новішої.
  list: (chatId: number) => readonly SpecialInstruction[];
  add: (chatId: number, text: string, createdByUserId?: number | null) => SpecialInstruction;
  remove: (chatId: number, id: number) => boolean;
};

interface InstructionRow {
  id: number;
  chat_id: number;
  text: string;
  created_at: number;
}

// Без кешу: інструкцій одиниці, а читаються вони раз на виклик моделі.
export function makeInstructionStore(db: Db): InstructionStore {
  const listStmt = db.prepare(
    `SELECT id, chat_id, text, created_at FROM special_instructions
     WHERE chat_id = ? ORDER BY id ASC`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO special_instructions (chat_id, text, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteStmt = db.prepare("DELETE FROM special_instructions WHERE chat_id = ? AND id = ?");

  return {
    list: (chatId) =>
      (listStmt.all(chatId) as InstructionRow[]).map((r) => ({
        id: r.id,
        chatId: r.chat_id,
        text: r.text,
        createdAt: r.created_at,
      })),

    add: (chatId, text, createdByUserId = null) => {
      const createdAt = Date.now();
      const result = insertStmt.run(chatId, text, createdAt, createdByUserId);
      return { id: Number(result.lastInsertRowid), chatId, text, createdAt };
    },

    remove: (chatId, id) => deleteStmt.run(chatId, id).changes > 0,
  };
}
