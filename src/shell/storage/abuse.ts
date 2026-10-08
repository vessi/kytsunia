import type { Db } from "./db.js";

export type AbuseBan = {
  userId: number;
  userName: string | null;
  since: number;
  until: number | null;
  strikes: number;
};
export type AbuseSummary = {
  userId: number;
  userName: string | null;
  strikes: number;
  lastTs: number;
  ban: AbuseBan | null;
};

export type AbuseStore = {
  // Повертає новий лічильник.
  addStrike: (s: {
    userId: number;
    chatId: number;
    msgId: number;
    ts: number;
    reason: string;
  }) => number;
  strikeCount: (userId: number) => number;
  setBan: (ban: AbuseBan) => void;
  // Чинний бан на момент now; прострочений тижневий — не чинний.
  activeBan: (userId: number, now: number) => AbuseBan | null;
  bannedUserIds: (now: number) => number[];
  // «Пробач»: стирає удари й бан. true, якщо було що стирати.
  forgive: (userId: number) => boolean;
  summary: () => AbuseSummary[];
};

interface BanRow {
  user_id: number;
  user_name: string | null;
  since: number;
  until: number | null;
  strikes: number;
}

const toBan = (r: BanRow): AbuseBan => ({
  userId: r.user_id,
  userName: r.user_name,
  since: r.since,
  until: r.until,
  strikes: r.strikes,
});

export function makeAbuseStore(db: Db): AbuseStore {
  const insertStrike = db.prepare(
    "INSERT INTO abuse_strikes (user_id, chat_id, msg_id, ts, reason) VALUES (?, ?, ?, ?, ?)",
  );
  const countStmt = db.prepare("SELECT COUNT(*) as n FROM abuse_strikes WHERE user_id = ?");
  const upsertBan = db.prepare(
    `INSERT INTO abuse_bans (user_id, user_name, since, until, strikes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET user_name = excluded.user_name, since = excluded.since,
       until = excluded.until, strikes = excluded.strikes`,
  );
  const banStmt = db.prepare("SELECT * FROM abuse_bans WHERE user_id = ?");
  const activeStmt = db.prepare("SELECT user_id FROM abuse_bans WHERE until IS NULL OR until > ?");
  const delStrikes = db.prepare("DELETE FROM abuse_strikes WHERE user_id = ?");
  const delBan = db.prepare("DELETE FROM abuse_bans WHERE user_id = ?");
  const summaryStmt = db.prepare(
    `SELECT s.user_id, COUNT(*) as strikes, MAX(s.ts) as last_ts,
            b.user_name, b.since, b.until, b.strikes as ban_strikes
     FROM abuse_strikes s LEFT JOIN abuse_bans b ON b.user_id = s.user_id
     GROUP BY s.user_id ORDER BY strikes DESC, last_ts DESC`,
  );

  const active = (userId: number, now: number): AbuseBan | null => {
    const r = banStmt.get(userId) as BanRow | undefined;
    if (!r) return null;
    if (r.until !== null && r.until <= now) return null;
    return toBan(r);
  };

  return {
    addStrike: (s) => {
      insertStrike.run(s.userId, s.chatId, s.msgId, s.ts, s.reason);
      return (countStmt.get(s.userId) as { n: number }).n;
    },
    strikeCount: (userId) => (countStmt.get(userId) as { n: number }).n,
    setBan: (b) => {
      upsertBan.run(b.userId, b.userName, b.since, b.until, b.strikes);
    },
    activeBan: active,
    bannedUserIds: (now) =>
      (activeStmt.all(now) as Array<{ user_id: number }>).map((r) => r.user_id),
    forgive: (userId) => {
      const a = delStrikes.run(userId).changes;
      const b = delBan.run(userId).changes;
      return a + b > 0;
    },
    summary: () =>
      (
        summaryStmt.all() as Array<{
          user_id: number;
          strikes: number;
          last_ts: number;
          user_name: string | null;
          since: number | null;
          until: number | null;
          ban_strikes: number | null;
        }>
      ).map((r) => ({
        userId: r.user_id,
        userName: r.user_name,
        strikes: r.strikes,
        lastTs: r.last_ts,
        ban:
          r.since === null
            ? null
            : {
                userId: r.user_id,
                userName: r.user_name,
                since: r.since,
                until: r.until,
                strikes: r.ban_strikes ?? 0,
              },
      })),
  };
}
