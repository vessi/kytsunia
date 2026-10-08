import type Database from "better-sqlite3";
import type { Context } from "grammy";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABUSE_PROMPT,
  type AbuseGuardDeps,
  makeAbuseGuard,
  parseVerdict,
} from "../../../src/shell/llm/abuse-guard.js";
import type { LlmClient, LlmReply } from "../../../src/shell/llm/anthropic.js";
import { makeAbuseStore } from "../../../src/shell/storage/abuse.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });
const NOW = Date.UTC(2026, 10, 12, 12, 0);
const DAY = 86_400_000;

describe("parseVerdict", () => {
  it("reads the first line as the verdict and the rest as the reason", () => {
    expect(parseVerdict("ABUSE\nПогрози й приниження.")).toEqual({
      abuse: true,
      reason: "Погрози й приниження.",
    });
    expect(parseVerdict("ok\nЗвичайний підкол.")).toEqual({
      abuse: false,
      reason: "Звичайний підкол.",
    });
    expect(parseVerdict("OK")).toEqual({ abuse: false, reason: "OK" });
  });
});

describe("abuse store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("counts strikes, tracks bans with expiry and forgives", () => {
    const store = makeAbuseStore(db);
    expect(store.addStrike({ userId: 42, chatId: -1, msgId: 1, ts: NOW, reason: "r" })).toBe(1);
    expect(store.addStrike({ userId: 42, chatId: -1, msgId: 2, ts: NOW, reason: "r" })).toBe(2);
    expect(store.strikeCount(42)).toBe(2);
    expect(store.activeBan(42, NOW)).toBeNull();

    store.setBan({ userId: 42, userName: "Troll", since: NOW, until: NOW + 7 * DAY, strikes: 3 });
    expect(store.activeBan(42, NOW + DAY)?.until).toBe(NOW + 7 * DAY);
    expect(store.activeBan(42, NOW + 8 * DAY)).toBeNull();
    expect(store.bannedUserIds(NOW + DAY)).toEqual([42]);
    expect(store.bannedUserIds(NOW + 8 * DAY)).toEqual([]);

    store.setBan({ userId: 42, userName: "Troll", since: NOW, until: null, strikes: 5 });
    expect(store.activeBan(42, NOW + 400 * DAY)?.until).toBeNull();
    expect(store.summary()).toMatchObject([{ userId: 42, strikes: 2, ban: { until: null } }]);

    expect(store.forgive(42)).toBe(true);
    expect(store.forgive(42)).toBe(false);
    expect(store.strikeCount(42)).toBe(0);
    expect(store.activeBan(42, NOW)).toBeNull();
  });
});

describe("abuse guard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function make(verdicts: string[], overrides: Partial<AbuseGuardDeps> = {}) {
    const calls: Array<{ system: unknown; content: unknown }> = [];
    const client: LlmClient = {
      reply: async (system, content): Promise<LlmReply> => {
        calls.push({ system, content });
        const text = verdicts.shift();
        if (text === undefined) throw new Error("boom");
        return { text, inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
      },
    };
    const store = makeAbuseStore(db);
    const guard = makeAbuseGuard({
      enabled: true,
      llmClient: client,
      llmCallStore: makeLlmCallStore(db),
      store,
      model: "claude-haiku-4-5",
      weekAt: 3,
      foreverAt: 5,
      banMs: 7 * DAY,
      now: () => NOW,
      log: silentLog,
      ...overrides,
    });
    const reply = vi.fn().mockResolvedValue({});
    const ctx = { reply } as unknown as Context;
    return { guard, store, calls, reply, ctx };
  }

  const input = { chatId: -1, userId: 42, userName: "Troll", msgId: 10, text: "Кицюня, ти ніщо" };

  it("sends the text to the classifier with the abuse prompt, weight 0", async () => {
    const { guard, calls, ctx } = make(["OK\nПідкол."]);
    expect(await guard.check(ctx, input)).toBe("ok");
    expect(calls[0]).toEqual({ system: ABUSE_PROMPT, content: "Кицюня, ти ніщо" });
    const row = db.prepare("SELECT weight, status FROM llm_calls").get() as {
      weight: number;
      status: string;
    };
    expect(row).toEqual({ weight: 0, status: "ok" });
  });

  it("counts strikes silently, bans for a week at the third and forever at the fifth", async () => {
    const abuse = "ABUSE\nПриниження.";
    const { guard, store, ctx, reply } = make([abuse, abuse, abuse, abuse, abuse]);
    expect(await guard.check(ctx, input)).toBe("ok");
    expect(await guard.check(ctx, input)).toBe("ok");
    expect(reply).not.toHaveBeenCalled();

    expect(await guard.check(ctx, input)).toBe("banned");
    expect(reply.mock.calls[0]?.[0]).toContain("Тиждень");
    expect(store.activeBan(42, NOW)?.until).toBe(NOW + 7 * DAY);

    // Після тижня — четвертий без коментаря, пʼятий назавжди.
    expect(await guard.check(ctx, input)).toBe("ok");
    expect(await guard.check(ctx, input)).toBe("banned");
    expect(reply.mock.calls[1]?.[0]).toContain("більше не існуєш");
    expect(store.activeBan(42, NOW + 400 * DAY)?.until).toBeNull();
    expect(store.strikeCount(42)).toBe(5);
  });

  it("lets the message through when the classifier fails or the guard is off", async () => {
    const failing = make([]);
    expect(await failing.guard.check(failing.ctx, input)).toBe("ok");
    expect(failing.store.strikeCount(42)).toBe(0);
    const row = db.prepare("SELECT status FROM llm_calls").get() as { status: string };
    expect(row.status).toBe("error");

    const off = make(["ABUSE\nx"], { enabled: false });
    expect(await off.guard.check(off.ctx, input)).toBe("ok");
    expect(off.calls).toHaveLength(0);
  });
});
