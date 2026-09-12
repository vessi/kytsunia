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

  describe("weight", () => {
    const base = {
      ts: Date.now(),
      chatId: 1,
      userId: 100,
      userName: "test",
      triggerMsgId: 50,
      model: "claude-haiku-4-5",
      status: "ok" as const,
    };

    it("defaults to 1 when not given", () => {
      store.record(base);
      const row = db.prepare("SELECT weight FROM llm_calls").get() as { weight: number };
      expect(row.weight).toBe(1);
    });

    it("counts toward the user limit by weight, not by call count", () => {
      store.record({ ...base, weight: 3 });
      const status = store.checkUserRate(100, 15);
      expect(status.used).toBe(3);
    });

    it("counts toward the global cap by weight", () => {
      store.record({ ...base, weight: 3 });
      store.record({ ...base, userId: 200, weight: 1 });
      expect(store.checkGlobalRate(150).used).toBe(4);
    });

    it("ignores weight of non-ok calls", () => {
      store.record({ ...base, status: "error", weight: 3 });
      expect(store.checkUserRate(100, 15).used).toBe(0);
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

describe("llmCallStore.usageSummary", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeLlmCallStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeLlmCallStore(db);
  });

  afterEach(() => {
    db.close();
  });

  const base = {
    chatId: 1,
    userId: 100,
    userName: "Andriy",
    triggerMsgId: 1,
    model: "claude-sonnet-5",
  };

  it("sums only successful calls and counts the rest separately", () => {
    store.record({
      ...base,
      ts: 1000,
      status: "ok",
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
    store.record({ ...base, ts: 1001, status: "error", errorMessage: "boom" });
    store.record({ ...base, ts: 1002, status: "rate_limited", errorMessage: "user_limit" });
    store.record({ ...base, ts: 1003, status: "rate_limited", errorMessage: "global_cap" });

    const s = store.usageSummary(0);
    expect(s.ok).toEqual({
      calls: 1,
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
    expect(s.errors).toBe(1);
    expect(s.rateLimited).toBe(2);
  });

  it("respects the since timestamp", () => {
    store.record({ ...base, ts: 500, status: "ok", costUsd: 1 });
    store.record({ ...base, ts: 1500, status: "ok", costUsd: 2 });
    const s = store.usageSummary(1000);
    expect(s.ok.calls).toBe(1);
    expect(s.ok.costUsd).toBe(2);
  });

  it("groups by chat, user and model, most expensive first", () => {
    store.record({
      ...base,
      ts: 1,
      chatId: 1,
      userId: 100,
      userName: "Andriy",
      status: "ok",
      costUsd: 0.1,
    });
    store.record({
      ...base,
      ts: 2,
      chatId: 2,
      userId: 200,
      userName: "Olha",
      status: "ok",
      costUsd: 0.5,
    });
    store.record({
      ...base,
      ts: 3,
      chatId: 2,
      userId: 200,
      userName: "Olha",
      model: "claude-haiku-4-5-20251001",
      status: "ok",
      costUsd: 0.05,
    });

    const s = store.usageSummary(0);
    expect(s.byChat.map((c) => [c.chatId, c.calls])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect(s.byUser.map((u) => u.userName)).toEqual(["Olha", "Andriy"]);
    expect(s.byModel.map((m) => m.model)).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  it("returns zeros when there is nothing", () => {
    const s = store.usageSummary(0);
    expect(s.ok.calls).toBe(0);
    expect(s.ok.costUsd).toBe(0);
    expect(s.byChat).toEqual([]);
    expect(s.byUser).toEqual([]);
  });
});
