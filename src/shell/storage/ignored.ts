import type { Db } from "./db.js";

export type IgnoredUser = { userId: number; userName: string | null; ignoredAt: number };

export type IgnoredUsersStore = {
  isIgnored: (userId: number) => boolean;
  // true, якщо запис новий.
  add: (userId: number, userName: string | null, byUserId?: number | null) => boolean;
  remove: (userId: number) => boolean;
  list: () => IgnoredUser[];
};

interface Row {
  user_id: number;
  user_name: string | null;
  ignored_at: number;
}

export function makeIgnoredUsersStore(db: Db): IgnoredUsersStore {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ignored_users (user_id, user_name, ignored_at, ignored_by_user_id)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteStmt = db.prepare("DELETE FROM ignored_users WHERE user_id = ?");
  const existsStmt = db.prepare("SELECT 1 FROM ignored_users WHERE user_id = ?");
  const listStmt = db.prepare(
    "SELECT user_id, user_name, ignored_at FROM ignored_users ORDER BY ignored_at ASC",
  );

  return {
    isIgnored: (userId) => existsStmt.get(userId) !== undefined,
    add: (userId, userName, byUserId = null) =>
      insertStmt.run(userId, userName, Date.now(), byUserId).changes > 0,
    remove: (userId) => deleteStmt.run(userId).changes > 0,
    list: () =>
      (listStmt.all() as Row[]).map((r) => ({
        userId: r.user_id,
        userName: r.user_name,
        ignoredAt: r.ignored_at,
      })),
  };
}
