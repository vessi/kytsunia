import type Database from "better-sqlite3";
import type { Context } from "grammy";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmReply, SystemContent } from "../../../src/shell/llm/anthropic.js";
import {
  CHIME_PROMPT,
  type ChimeDeps,
  invokeChime,
  isSilence,
  makeChimeScheduler,
} from "../../../src/shell/llm/chime.js";
import { makeChatSettingsStore } from "../../../src/shell/storage/chat-settings.js";
import { makeInstructionStore } from "../../../src/shell/storage/instructions.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { makeRegularsStore } from "../../../src/shell/storage/regulars.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

// 2026-09-30T12:00:00Z = 15:00 за Києвом, поза тихими годинами.
const NOON = Date.UTC(2026, 8, 30, 12, 0);
// 2026-09-30T21:30:00Z = 00:30 за Києвом наступної доби, тихі години.
const NIGHT = Date.UTC(2026, 8, 30, 21, 30);

describe("isSilence", () => {
  it("accepts the word with punctuation and case noise", () => {
    for (const t of ["мовчу", "Мовчу.", "«мовчу»", " мовчу! "]) expect(isSilence(t)).toBe(true);
    for (const t of ["мовчу, але", "ок", ""]) expect(isSilence(t)).toBe(false);
  });
});

describe("chime scheduler", () => {
  const policy = {
    every: 10,
    dailyCap: 2,
    minGapMs: 30 * 60_000,
    quietFromHour: 23,
    quietToHour: 8,
  };

  it("fires once per ~every messages, with jitter within ±20%", () => {
    const s = makeChimeScheduler(
      policy,
      () => 0.5,
      () => NOON,
    );
    const hits: number[] = [];
    for (let i = 1; i <= 40; i++) if (s.noteMessage(-1)) hits.push(i);
    expect(hits).toEqual([10, 20, 30, 40]);

    const low = makeChimeScheduler(
      policy,
      () => 0,
      () => NOON,
    );
    let first = 0;
    for (let i = 1; i <= 20 && !first; i++) if (low.noteMessage(-1)) first = i;
    expect(first).toBe(8);
  });

  it("keeps chats apart", () => {
    const s = makeChimeScheduler(
      policy,
      () => 0.5,
      () => NOON,
    );
    for (let i = 0; i < 9; i++) s.noteMessage(-1);
    expect(s.noteMessage(-2)).toBe(false);
    expect(s.noteMessage(-1)).toBe(true);
  });

  it("stays silent in quiet hours", () => {
    const s = makeChimeScheduler(
      policy,
      () => 0.5,
      () => NIGHT,
    );
    let fired = false;
    for (let i = 0; i < 10; i++) fired = s.noteMessage(-1) || fired;
    expect(fired).toBe(false);
  });

  it("enforces the gap and the daily cap after speaking", () => {
    let now = NOON;
    const s = makeChimeScheduler(
      policy,
      () => 0.5,
      () => now,
    );
    const fire = () => {
      let f = false;
      for (let i = 0; i < 10; i++) f = s.noteMessage(-1) || f;
      return f;
    };
    expect(fire()).toBe(true);
    s.noteSpoke(-1);
    expect(fire()).toBe(false); // пауза 30 хв
    now += 31 * 60_000;
    expect(fire()).toBe(true);
    s.noteSpoke(-1);
    now += 31 * 60_000;
    expect(fire()).toBe(false); // стеля 2 на добу
    now += 24 * 3600_000;
    expect(fire()).toBe(true); // нова доба
  });
});

describe("invokeChime", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    const append = makeMessageAppender(db);
    for (let i = 1; i <= 5; i++) {
      append({
        chatId: -1,
        messageId: i,
        ts: NOON - (6 - i) * 1000,
        senderId: i % 2 ? 7 : 8,
        senderName: i % 2 ? "Andriy" : "Olha",
        text: `репліка ${i}`,
        kind: "text",
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  function make(text: string) {
    const calls: Array<{ system: SystemContent; content: unknown; model: string }> = [];
    const client: LlmClient = {
      reply: async (system, content, model): Promise<LlmReply> => {
        calls.push({ system, content, model });
        return { text, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
      },
    };
    const sendMessage = vi.fn(async () => ({ message_id: 77, date: Math.floor(NOON / 1000) }));
    const ctx = { api: { sendMessage } } as unknown as Context;
    const appendMessage = vi.fn();
    const deps: ChimeDeps = {
      db,
      llmClient: client,
      llmCallStore: makeLlmCallStore(db),
      chatSettings: makeChatSettingsStore(db),
      regularsStore: makeRegularsStore(db),
      instructionStore: makeInstructionStore(db),
      model: "claude-sonnet-5",
      digestModel: "claude-sonnet-5",
      persona: (m, d, c) => `P:${m}/${d}/${c}`,
      cacheTtl: "1h",
      botUserId: 9999,
      botName: "Кицюня",
      replyMaxTokens: 500,
      globalDailyCap: 150,
      contextSize: 100,
      appendMessage,
      now: () => NOON,
      log: silentLog,
    };
    return { deps, ctx, calls, sendMessage, appendMessage };
  }

  it("stays quiet on «мовчу» but still records the call", async () => {
    const { deps, ctx, calls, sendMessage } = make("Мовчу.");
    expect(await invokeChime(ctx, -1, deps)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const system = calls[0]?.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]?.text).toBe("P:claude-sonnet-5/claude-sonnet-5/null");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const tail = system.at(-1)?.text ?? "";
    expect(tail).toContain(CHIME_PROMPT);
    expect(tail).toContain("Andriy: репліка 5");
    const row = db.prepare("SELECT status, weight, user_id FROM llm_calls").get() as {
      status: string;
      weight: number;
      user_id: number;
    };
    expect(row).toEqual({ status: "ok", weight: 1, user_id: 9999 });
  });

  it("speaks as a reply to the latest message and stores its own line", async () => {
    const { deps, ctx, sendMessage, appendMessage } = make("Ну нарешті хтось сказав.");
    expect(await invokeChime(ctx, -1, deps)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(-1, "Ну нарешті хтось сказав.", {
      reply_parameters: { message_id: 5 },
    });
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: -1,
        messageId: 77,
        senderId: 9999,
        text: "Ну нарешті хтось сказав.",
      }),
    );
  });

  it("uses the chat's model override", async () => {
    const { deps, ctx, calls } = make("мовчу");
    deps.chatSettings.setModel(-1, "claude-opus-5-5");
    await invokeChime(ctx, -1, deps);
    expect(calls[0]?.model).toBe("claude-opus-5-5");
  });

  it("does nothing in an empty chat", async () => {
    const { deps, ctx, calls } = make("мовчу");
    expect(await invokeChime(ctx, -2, deps)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
