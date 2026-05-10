import type { Db } from "./db.js";

export type OptOutsStore = {
  isOptedOut: (userId: number) => boolean;
  optOut: (userId: number, reason?: string) => void;
  optIn: (userId: number) => boolean;
  list: () => number[];
};

interface OptOutRow {
  user_id: number;
}

export function makeOptOutsStore(db: Db): OptOutsStore {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO profile_opt_outs (user_id, opted_out_at, reason)
     VALUES (?, ?, ?)`,
  );
  const deleteStmt = db.prepare("DELETE FROM profile_opt_outs WHERE user_id = ?");
  const existsStmt = db.prepare("SELECT 1 FROM profile_opt_outs WHERE user_id = ?");
  const listStmt = db.prepare("SELECT user_id FROM profile_opt_outs");

  return {
    isOptedOut: (userId) => existsStmt.get(userId) !== undefined,

    optOut: (userId, reason) => {
      insertStmt.run(userId, Date.now(), reason ?? null);
    },

    optIn: (userId) => {
      const result = deleteStmt.run(userId);
      return result.changes > 0;
    },

    list: () => {
      const rows = listStmt.all() as OptOutRow[];
      return rows.map((r) => r.user_id);
    },
  };
}
