import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { openTestDb } from "../../helpers/db.js";

describe("llmCallStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeLlmCallStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeLlmCallStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("record", () => {
    it("inserts a call record", () => {
      store.record({
        ts: Date.now(),
        chatId: 1,
        userId: 100,
        userName: "test",
        triggerMsgId: 50,
        model: "claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 50,
        status: "ok",
        costUsd: 0.001,
      });

      const rows = db.prepare("SELECT COUNT(*) as n FROM llm_calls").get() as { n: number };
      expect(rows.n).toBe(1);
    });
  });

  describe("checkUserRate", () => {
    it("uses default limit when user has no override", () => {
      const status = store.checkUserRate(100, 15);
      expect(status).toEqual({ used: 0, limit: 15, allowed: true });
    });

    it("uses user-specific limit when override exists", () => {
      db.prepare("INSERT INTO user_limits (user_id, daily_limit, updated_at) VALUES (?, ?, ?)").run(
        100,
        5,
        Date.now(),
      );

      const status = store.checkUserRate(100, 15);
      expect(status.limit).toBe(5);
    });

    it("returns null limit when user is unlimited", () => {
      db.prepare(
        "INSERT INTO user_limits (user_id, daily_limit, updated_at) VALUES (?, NULL, ?)",
      ).run(100, Date.now());

      const status = store.checkUserRate(100, 15);
      expect(status.limit).toBeNull();
      expect(status.allowed).toBe(true);
    });

    it("counts only ok-status calls in today", () => {
      const now = Date.now();
      const baseRecord = {
        ts: now,
        chatId: 1,
        userId: 100,
        userName: "x",
        triggerMsgId: 1,
        model: "m",
      };

      store.record({ ...baseRecord, status: "ok" });
      store.record({ ...baseRecord, status: "ok" });
      store.record({ ...baseRecord, status: "rate_limited" });
      store.record({ ...baseRecord, status: "error" });

      const status = store.checkUserRate(100, 15);
      expect(status.used).toBe(2);
    });

    it("denies when at limit", () => {
      const baseRecord = {
        ts: Date.now(),
        chatId: 1,
        userId: 100,
        userName: "x",
        triggerMsgId: 1,
        model: "m",
        status: "ok" as const,
      };
      for (let i = 0; i < 5; i++) store.record(baseRecord);

      expect(store.checkUserRate(100, 5).allowed).toBe(false);
    });
  });

  describe("checkGlobalRate", () => {
    it("counts across all users", () => {
      const baseRecord = {
        ts: Date.now(),
        chatId: 1,
        userName: "x",
        triggerMsgId: 1,
        model: "m",
        status: "ok" as const,
      };
      store.record({ ...baseRecord, userId: 100 });
      store.record({ ...baseRecord, userId: 200 });
      store.record({ ...baseRecord, userId: 300 });

      const status = store.checkGlobalRate(150);
      expect(status.used).toBe(3);
      expect(status.allowed).toBe(true);
    });

    it("denies when at cap", () => {
      const baseRecord = {
        ts: Date.now(),
        chatId: 1,
        userName: "x",
        triggerMsgId: 1,
        model: "m",
        status: "ok" as const,
      };
      for (let i = 0; i < 5; i++) store.record({ ...baseRecord, userId: i });

      expect(store.checkGlobalRate(5).allowed).toBe(false);
    });
  });
});
