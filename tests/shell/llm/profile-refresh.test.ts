import type Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmReply } from "../../../src/shell/llm/anthropic.js";
import {
  buildProfileRequest,
  findCandidates,
  PROFILE_GENERATOR_PROMPT,
  refreshProfiles,
} from "../../../src/shell/llm/profile-refresh.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { makeRegularsStore } from "../../../src/shell/storage/regulars.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });
const DAY = 86_400_000;

describe("profile refresh", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function seed(chatId: number, senderId: number, name: string, count: number, ageDays = 1) {
    const append = makeMessageAppender(db);
    for (let i = 0; i < count; i++) {
      append({
        chatId,
        messageId: chatId * 100_000 + senderId * 1000 + i,
        ts: Date.now() - ageDays * DAY + i,
        senderId,
        senderName: name,
        text: `повідомлення ${i}`,
        kind: "text",
      });
    }
  }

  function fakeLlm(text = "Пише коротко.", fail = false) {
    const calls: Array<{ system: unknown; content: unknown; model: string }> = [];
    const client: LlmClient = {
      reply: async (system, content, model): Promise<LlmReply> => {
        calls.push({ system, content, model });
        if (fail) throw new Error("boom");
        return {
          text,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    return { client, calls };
  }

  function deps(client: LlmClient, optedOut: number[] = []) {
    return {
      db,
      llmClient: client,
      regularsStore: makeRegularsStore(db),
      llmCallStore: makeLlmCallStore(db),
      optedOutUserIds: () => new Set(optedOut),
      log: silentLog,
    };
  }

  const opts = { threshold: 5, days: 30, limitMessages: 200, model: "claude-sonnet-5" };

  describe("findCandidates", () => {
    it("applies the threshold per user and chat, within the window", () => {
      seed(1, 10, "Andriy", 6);
      seed(1, 11, "Olha", 4);
      seed(2, 10, "Andriy", 7);
      seed(1, 12, "Old", 20, 60);
      const found = findCandidates(db, { threshold: 5 }, Date.now() - 30 * DAY);
      expect(found.map((c) => [c.chatId, c.userId, c.messageCount])).toEqual([
        [2, 10, 7],
        [1, 10, 6],
      ]);
    });

    it("narrows to one chat", () => {
      seed(1, 10, "Andriy", 6);
      seed(2, 10, "Andriy", 7);
      const found = findCandidates(db, { threshold: 5, chatId: 1 }, Date.now() - 30 * DAY);
      expect(found.map((c) => c.chatId)).toEqual([1]);
    });

    it("ignores the threshold for a single user", () => {
      seed(1, 11, "Olha", 2);
      const found = findCandidates(db, { threshold: 5, userId: 11 }, Date.now() - 30 * DAY);
      expect(found).toHaveLength(1);
    });
  });

  it("builds the request with the oldest message first", () => {
    const text = buildProfileRequest(
      { userId: 1, chatId: 2, userName: "Olha", messageCount: 2, lastMessageTs: 0 },
      ["перше", "друге"],
    );
    expect(text).toContain("Ім'я: Olha");
    expect(text.indexOf("перше")).toBeLessThan(text.indexOf("друге"));
  });

  it("generates and stores a profile per candidate of the chat", async () => {
    seed(1, 10, "Andriy", 6);
    seed(1, 11, "Olha", 6);
    seed(2, 12, "Other", 6);
    const llm = fakeLlm();
    const d = deps(llm.client);
    const result = await refreshProfiles(d, { ...opts, chatId: 1, requestedByUserId: 99 });

    expect(result).toEqual({
      processed: 2,
      failed: 0,
      skipped: 0,
      totalCostUsd: expect.any(Number),
    });
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.system).toBe(PROFILE_GENERATOR_PROMPT);
    expect(llm.calls[0]?.model).toBe("claude-sonnet-5");
    expect(d.regularsStore.get(10, 1)?.profile).toBe("Пише коротко.");
    expect(d.regularsStore.get(11, 1)?.messageCount).toBe(6);
    expect(d.regularsStore.get(12, 2)).toBeNull();

    // У звіті видно, добові ліміти не зʼїдає.
    const rows = db
      .prepare("SELECT weight, user_id, chat_id, status FROM llm_calls")
      .all() as Array<{ weight: number; user_id: number; chat_id: number; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.weight === 0 && r.user_id === 99 && r.chat_id === 1)).toBe(true);
    expect(d.llmCallStore.checkUserRate(99, 15).used).toBe(0);
  });

  it("skips opted-out users and counts them", async () => {
    seed(1, 10, "Andriy", 6);
    seed(1, 11, "Olha", 6);
    const llm = fakeLlm();
    const result = await refreshProfiles(deps(llm.client, [11]), { ...opts, chatId: 1 });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps going after a failed profile and records the error", async () => {
    seed(1, 10, "Andriy", 6);
    seed(1, 11, "Olha", 6);
    const llm = fakeLlm("x", true);
    const d = deps(llm.client);
    const result = await refreshProfiles(d, { ...opts, chatId: 1 });
    expect(result).toMatchObject({ processed: 0, failed: 2 });
    const rows = db.prepare("SELECT status FROM llm_calls").all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["error", "error"]);
  });

  it("does not store anything in dry-run but still reports profiles", async () => {
    seed(1, 10, "Andriy", 6);
    const llm = fakeLlm();
    const d = deps(llm.client);
    const onProfile = vi.fn();
    const result = await refreshProfiles(d, { ...opts, chatId: 1, dryRun: true, onProfile });
    expect(result.processed).toBe(1);
    expect(onProfile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 10 }),
      "Пише коротко.",
      expect.any(Number),
    );
    expect(d.regularsStore.get(10, 1)).toBeNull();
  });

  it("returns zeros when nobody qualifies", async () => {
    seed(1, 10, "Andriy", 2);
    const llm = fakeLlm();
    const result = await refreshProfiles(deps(llm.client), { ...opts, chatId: 1 });
    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0, totalCostUsd: 0 });
    expect(llm.calls).toHaveLength(0);
  });
});
