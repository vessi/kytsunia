import { startOfKyivDay } from "../time.js";
import type { Db } from "./db.js";

export type CallStatus = "ok" | "rate_limited" | "error";

export type CallRecord = {
  ts: number;
  chatId: number;
  userId: number;
  userName: string;
  triggerMsgId: number;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: CallStatus;
  costUsd?: number;
  errorMessage?: string;
  // Скільки «слотів» добового ліміту зʼїдає виклик. Звичайний реплай — 1,
  // дайджест — більше, бо тягне сотні повідомлень у контекст.
  weight?: number;
};

export type RateCheck = {
  used: number;
  limit: number | null;
  allowed: boolean;
};

export type GlobalRateCheck = {
  used: number;
  cap: number;
  allowed: boolean;
};

export type UsageBucket = {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// Зведення успішних викликів з sinceTs. Помилки й відмови по ліміту — окремими
// лічильниками, у токени й вартість вони не входять.
export type UsageSummary = {
  ok: UsageBucket;
  errors: number;
  rateLimited: number;
  byChat: Array<{ chatId: number } & UsageBucket>;
  byUser: Array<{ userId: number; userName: string; calls: number; costUsd: number }>;
  byModel: Array<{ model: string; calls: number; costUsd: number }>;
};

export type LlmCallStore = {
  record: (record: CallRecord) => void;
  checkUserRate: (userId: number, defaultLimit: number) => RateCheck;
  checkGlobalRate: (cap: number) => GlobalRateCheck;
  usageSummary: (sinceTs: number) => UsageSummary;
};

interface UserLimitRow {
  daily_limit: number | null;
}
interface CountRow {
  n: number;
}

export function makeLlmCallStore(db: Db): LlmCallStore {
  const insertStmt = db.prepare(`
    INSERT INTO llm_calls (
      ts, chat_id, user_id, user_name, trigger_msg_id,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      status, cost_usd, error_message, weight
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const userLimitStmt = db.prepare("SELECT daily_limit FROM user_limits WHERE user_id = ?");
  // SUM(weight), не COUNT(*) — важкі виклики (дайджест) мають зʼїдати більше
  // ліміту, ніж односкладний реплай.
  const userUsedStmt = db.prepare(
    "SELECT COALESCE(SUM(weight), 0) as n FROM llm_calls WHERE user_id = ? AND ts >= ? AND status = 'ok'",
  );
  const globalUsedStmt = db.prepare(
    "SELECT COALESCE(SUM(weight), 0) as n FROM llm_calls WHERE ts >= ? AND status = 'ok'",
  );

  const BUCKET_COLS = `
    COUNT(*) as calls,
    COALESCE(SUM(cost_usd), 0) as costUsd,
    COALESCE(SUM(input_tokens), 0) as inputTokens,
    COALESCE(SUM(output_tokens), 0) as outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
    COALESCE(SUM(cache_write_tokens), 0) as cacheWriteTokens`;
  const totalStmt = db.prepare(
    `SELECT ${BUCKET_COLS} FROM llm_calls WHERE ts >= ? AND status = 'ok'`,
  );
  const statusStmt = db.prepare(
    "SELECT status, COUNT(*) as n FROM llm_calls WHERE ts >= ? GROUP BY status",
  );
  const byChatStmt = db.prepare(
    `SELECT chat_id as chatId, ${BUCKET_COLS} FROM llm_calls
     WHERE ts >= ? AND status = 'ok' GROUP BY chat_id ORDER BY costUsd DESC, calls DESC`,
  );
  // Імʼя беремо з останнього виклику — люди перейменовуються.
  const byUserStmt = db.prepare(
    `SELECT user_id as userId, COALESCE(MAX(user_name), '') as userName,
            COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as costUsd
     FROM llm_calls WHERE ts >= ? AND status = 'ok'
     GROUP BY user_id ORDER BY costUsd DESC, calls DESC LIMIT 5`,
  );
  const byModelStmt = db.prepare(
    `SELECT model, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as costUsd
     FROM llm_calls WHERE ts >= ? AND status = 'ok'
     GROUP BY model ORDER BY costUsd DESC, calls DESC`,
  );

  return {
    usageSummary: (sinceTs) => {
      const ok = totalStmt.get(sinceTs) as UsageBucket;
      const statuses = statusStmt.all(sinceTs) as Array<{ status: CallStatus; n: number }>;
      const count = (st: CallStatus) => statuses.find((r) => r.status === st)?.n ?? 0;
      return {
        ok,
        errors: count("error"),
        rateLimited: count("rate_limited"),
        byChat: byChatStmt.all(sinceTs) as UsageSummary["byChat"],
        byUser: byUserStmt.all(sinceTs) as UsageSummary["byUser"],
        byModel: byModelStmt.all(sinceTs) as UsageSummary["byModel"],
      };
    },

    record: (r) => {
      insertStmt.run(
        r.ts,
        r.chatId,
        r.userId,
        r.userName,
        r.triggerMsgId,
        r.model,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.cacheReadTokens ?? null,
        r.cacheWriteTokens ?? null,
        r.status,
        r.costUsd ?? null,
        r.errorMessage ?? null,
        r.weight ?? 1,
      );
    },

    checkUserRate: (userId, defaultLimit) => {
      const limitRow = userLimitStmt.get(userId) as UserLimitRow | undefined;
      // Якщо запису user_limits немає — використовуємо default.
      // Якщо є і daily_limit = NULL — безлімітно.
      const limit = limitRow === undefined ? defaultLimit : limitRow.daily_limit;

      if (limit === null) {
        return { used: 0, limit: null, allowed: true };
      }

      const usedRow = userUsedStmt.get(userId, startOfKyivDay()) as CountRow;
      return {
        used: usedRow.n,
        limit,
        allowed: usedRow.n < limit,
      };
    },

    checkGlobalRate: (cap) => {
      const usedRow = globalUsedStmt.get(startOfKyivDay()) as CountRow;
      return {
        used: usedRow.n,
        cap,
        allowed: usedRow.n < cap,
      };
    },
  };
}
