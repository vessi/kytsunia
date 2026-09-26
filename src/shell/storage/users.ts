import type { Db } from "./db.js";

export type KnownUser = { userId: number; username: string | null; firstName: string | null };

export type UsersStore = {
  // Пишемо кожен раз: username і імʼя змінюються, а це дешевий upsert.
  upsert: (user: KnownUser) => void;
  usernameOf: (userId: number) => string | null;
};

export function makeUsersStore(db: Db): UsersStore {
  const upsertStmt = db.prepare(
    `INSERT INTO users (user_id, username, first_name, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       updated_at = excluded.updated_at`,
  );
  const usernameStmt = db.prepare("SELECT username FROM users WHERE user_id = ?");
  return {
    upsert: (u) => {
      upsertStmt.run(u.userId, u.username, u.firstName, Date.now());
    },
    usernameOf: (userId) =>
      (usernameStmt.get(userId) as { username: string | null } | undefined)?.username ?? null,
  };
}
