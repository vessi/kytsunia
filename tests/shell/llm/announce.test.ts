import type Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_PROMPT, type AnnounceDeps, announce } from "../../../src/shell/llm/announce.js";
import type { LlmClient, LlmReply, SystemContent } from "../../../src/shell/llm/anthropic.js";
import { makeChatSettingsStore } from "../../../src/shell/storage/chat-settings.js";
import { makeChatsStore } from "../../../src/shell/storage/chats.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

describe("announce", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    const chats = makeChatsStore(db);
    chats.seen(-1, "A");
    chats.seen(-2, "B");
    chats.seen(-3, "C");
    chats.setAnnounce(-3, false);
  });

  afterEach(() => {
    db.close();
  });

  function make(failChat?: number) {
    const calls: Array<{ system: SystemContent; content: unknown; model: string }> = [];
    const client: LlmClient = {
      reply: async (system, content, model): Promise<LlmReply> => {
        calls.push({ system, content, model });
        return {
          text: `переказ для ${model}`,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    const sendMessage = vi.fn(async (chatId: number, _text?: string) => {
      if (chatId === failChat)
        throw new Error("Forbidden: bot was kicked from the supergroup chat");
      return { message_id: 1 };
    });
    const chats = makeChatsStore(db);
    const chatSettings = makeChatSettingsStore(db);
    const deps: AnnounceDeps = {
      api: { sendMessage } as never,
      llmClient: client,
      llmCallStore: makeLlmCallStore(db),
      chats,
      chatSettings,
      model: "claude-sonnet-5",
      digestModel: "claude-sonnet-5",
      persona: (m, d, c) => `P:${m}/${d}/${c}`,
      cacheTtl: "1h",
      botUserId: 9999,
      botName: "Кицюня",
      log: silentLog,
    };
    return { deps, calls, sendMessage, chats, chatSettings };
  }

  it("sends plain text to every active chat with announcements on", async () => {
    const { deps, calls, sendMessage } = make();
    const r = await announce(deps, "Новини.", false);
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 1, costUsd: 0 });
    expect(calls).toHaveLength(0);
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([-1, -2]);
    expect(sendMessage.mock.calls[0]?.[1]).toBe("Новини.");
  });

  it("rewrites in each chat's persona and model when asked", async () => {
    const { deps, calls, sendMessage, chatSettings } = make();
    chatSettings.setModel(-2, "claude-opus-5-5");
    chatSettings.setPersona(-2, "Ти сумна сова.");
    const r = await announce(deps, "- Перше.\n- Друге.", true);
    expect(r.sent).toBe(2);
    expect(calls.map((c) => c.model)).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
    const second = calls[1]?.system as Array<{ text: string }>;
    expect(second[0]?.text).toBe("P:claude-opus-5-5/claude-sonnet-5/Ти сумна сова.");
    expect(second[1]?.text).toBe(ANNOUNCE_PROMPT);
    expect(calls[1]?.content).toContain("- Перше.");
    expect(sendMessage.mock.calls[1]?.[1]).toBe("переказ для claude-opus-5-5");
    const rows = db.prepare("SELECT weight FROM llm_calls").all() as Array<{ weight: number }>;
    expect(rows).toEqual([{ weight: 0 }, { weight: 0 }]);
  });

  it("marks a chat as left when Telegram says the bot was kicked", async () => {
    const { deps, chats } = make(-2);
    const r = await announce(deps, "Новини.", false);
    expect(r).toMatchObject({ sent: 1, failed: 1, skipped: 1 });
    // −2 покинуто, −3 лишається активним, просто без оголошень.
    expect(chats.listActive().map((c) => c.chatId)).toEqual([-1, -3]);
  });
});
