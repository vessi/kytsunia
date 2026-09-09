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

export type LlmCallStore = {
  record: (record: CallRecord) => void;
  checkUserRate: (userId: number, defaultLimit: number) => RateCheck;
  checkGlobalRate: (cap: number) => GlobalRateCheck;
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

  return {
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
