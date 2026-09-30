import type Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmReply } from "../../../src/shell/llm/anthropic.js";
import {
  CHAT_OVERVIEW_PROMPT,
  describeChats,
  listGroupChats,
  renderOverview,
  renderStats,
} from "../../../src/shell/llm/chats-overview.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

describe("chats overview", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    const append = makeMessageAppender(db);
    let id = 1;
    const add = (chatId: number, senderId: number, name: string, n: number) => {
      for (let i = 0; i < n; i++) {
        append({
          chatId,
          messageId: id++,
          ts: 1_000_000 + id * 1000,
          senderId,
          senderName: name,
          text: `msg ${id}`,
          kind: "text",
        });
      }
    };
    add(-100, 1, "Olha", 5);
    add(-100, 2, "Andriy", 3);
    add(-100, 9999, "Кицюня", 10);
    add(-200, 3, "Ira", 2);
    add(42, 42, "Private", 7);
  });

  afterEach(() => {
    db.close();
  });

  it("lists group chats only, without the bot, most recent first", () => {
    const chats = listGroupChats(db, 9999);
    expect(chats.map((c) => c.chatId)).toEqual([-200, -100]);
    const big = chats.find((c) => c.chatId === -100);
    expect(big).toMatchObject({ messages: 8, people: 2 });
    expect(big?.topSenders).toEqual([
      { name: "Olha", count: 5 },
      { name: "Andriy", count: 3 },
    ]);
  });

  it("renders the stats header", () => {
    const text = renderStats(
      {
        chatId: -100,
        messages: 8,
        people: 2,
        firstTs: 0,
        lastTs: 0,
        topSenders: [{ name: "Olha", count: 5 }],
      },
      "Віскі-клуб",
      12,
    );
    expect(text).toContain("Чат: Віскі-клуб (-100)");
    expect(text).toContain("Учасників за Telegram: 12; писали в історії: 2");
    expect(text).toContain("Найактивніші: Olha (5)");
  });

  it("describes each chat with one model call and survives a failing chat", async () => {
    const calls: Array<{ system: unknown; content: unknown }> = [];
    const client: LlmClient = {
      reply: async (system, content): Promise<LlmReply> => {
        calls.push({ system, content });
        if (String(content).includes("(-200)")) throw new Error("boom");
        return {
          text: "Чат про віскі.",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    const api = {
      getChat: vi.fn(async (chatId: number) => ({
        title: chatId === -100 ? "Віскі-клуб" : "Інший",
      })),
      getChatMemberCount: vi.fn(async () => 12),
    };
    const items = await describeChats(
      {
        db,
        llmClient: client,
        llmCallStore: makeLlmCallStore(db),
        api: api as never,
        model: "claude-sonnet-5",
        botUserId: 9999,
        log: silentLog,
      },
      { chatId: 300, userId: 300, userName: "Admin" },
    );

    expect(items.map((i) => [i.chatId, i.title, i.description])).toEqual([
      [-200, "Інший", null],
      [-100, "Віскі-клуб", "Чат про віскі."],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.system).toBe(CHAT_OVERVIEW_PROMPT);
    expect(String(calls[1]?.content)).toContain("Olha: msg");
    const rows = db.prepare("SELECT status, weight FROM llm_calls ORDER BY id").all() as Array<{
      status: string;
      weight: number;
    }>;
    expect(rows).toEqual([
      { status: "error", weight: 0 },
      { status: "ok", weight: 0 },
    ]);

    const text = renderOverview(items);
    expect(text).toContain("Чат про віскі.");
    expect(text).toContain("Опис не вийшов");
    expect(text).toContain("Чатів: 2.");
  });

  it("has a friendly empty state", () => {
    expect(renderOverview([])).toContain("ні в одному");
  });
});
