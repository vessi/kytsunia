import type { Db } from "./db.js";

export type IgnoredUser = { userId: number; userName: string | null; ignoredAt: number };

/**
 * Два скоупи: глобальний (адмін бота, діє скрізь) і на чат (адмін чату з
 * правом обмежувати). Зняти чужий скоуп не можна: адмін чату не знімає
 * глобальний ігнор, а «не ігноруй» від адміна бота знімає обидва.
 */
export type IgnoredUsersStore = {
  isIgnored: (userId: number, chatId?: number) => boolean;
  isGloballyIgnored: (userId: number) => boolean;
  // true, якщо запис новий.
  addGlobal: (userId: number, userName: string | null, byUserId?: number | null) => boolean;
  removeGlobal: (userId: number) => boolean;
  listGlobal: () => IgnoredUser[];
  addInChat: (
    chatId: number,
    userId: number,
    userName: string | null,
    byUserId?: number | null,
  ) => boolean;
  removeInChat: (chatId: number, userId: number) => boolean;
  listInChat: (chatId: number) => IgnoredUser[];
};

interface Row {
  user_id: number;
  user_name: string | null;
  ignored_at: number;
}

const toUser = (r: Row): IgnoredUser => ({
  userId: r.user_id,
  userName: r.user_name,
  ignoredAt: r.ignored_at,
});

export function makeIgnoredUsersStore(db: Db): IgnoredUsersStore {
  const insertGlobal = db.prepare(
    `INSERT OR IGNORE INTO ignored_users (user_id, user_name, ignored_at, ignored_by_user_id)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteGlobal = db.prepare("DELETE FROM ignored_users WHERE user_id = ?");
  const existsGlobal = db.prepare("SELECT 1 FROM ignored_users WHERE user_id = ?");
  const listGlobalStmt = db.prepare(
    "SELECT user_id, user_name, ignored_at FROM ignored_users ORDER BY ignored_at ASC",
  );
  const insertChat = db.prepare(
    `INSERT OR IGNORE INTO chat_ignored_users (chat_id, user_id, user_name, ignored_at, ignored_by_user_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const deleteChat = db.prepare("DELETE FROM chat_ignored_users WHERE chat_id = ? AND user_id = ?");
  const existsChat = db.prepare(
    "SELECT 1 FROM chat_ignored_users WHERE chat_id = ? AND user_id = ?",
  );
  const listChatStmt = db.prepare(
    `SELECT user_id, user_name, ignored_at FROM chat_ignored_users
     WHERE chat_id = ? ORDER BY ignored_at ASC`,
  );

  return {
    isGloballyIgnored: (userId) => existsGlobal.get(userId) !== undefined,
    isIgnored: (userId, chatId) =>
      existsGlobal.get(userId) !== undefined ||
      (chatId !== undefined && existsChat.get(chatId, userId) !== undefined),
    addGlobal: (userId, userName, byUserId = null) =>
      insertGlobal.run(userId, userName, Date.now(), byUserId).changes > 0,
    removeGlobal: (userId) => deleteGlobal.run(userId).changes > 0,
    listGlobal: () => (listGlobalStmt.all() as Row[]).map(toUser),
    addInChat: (chatId, userId, userName, byUserId = null) =>
      insertChat.run(chatId, userId, userName, Date.now(), byUserId).changes > 0,
    removeInChat: (chatId, userId) => deleteChat.run(chatId, userId).changes > 0,
    listInChat: (chatId) => (listChatStmt.all(chatId) as Row[]).map(toUser),
  };
}
