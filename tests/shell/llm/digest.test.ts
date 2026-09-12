import type { Context } from "grammy";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LlmClient,
  LlmReply,
  SystemContent,
  UserContent,
} from "../../../src/shell/llm/anthropic.js";
import {
  buildDigestRequest,
  type InvokeDigestDeps,
  invokeDigest,
  renderTranscript,
  resolveCount,
  truncateForTelegram,
} from "../../../src/shell/llm/digest.js";
import type { Db } from "../../../src/shell/storage/db.js";
import { makeMessageAppender, type RecentMessageRow } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

function makeFakeLlm(text = "• перше\n• друге\n\nОт така у вас драма."): {
  client: LlmClient;
  calls: Array<{ system: SystemContent; content: UserContent; maxTokens?: number }>;
} {
  const calls: Array<{ system: SystemContent; content: UserContent; maxTokens?: number }> = [];
  const client: LlmClient = {
    reply: async (system, userMessage, _model, maxTokens): Promise<LlmReply> => {
      calls.push({
        system,
        content: userMessage,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      return {
        text,
        inputTokens: 12000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    },
  };
  return { client, calls };
}

function makeCtx(): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
  const ctx = {
    message: { message_id: 999, chat: { id: 1 }, from: { id: 7, first_name: "Andriy" }, date: 0 },
    chat: { id: 1 },
    from: { id: 7, first_name: "Andriy" },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function row(overrides: Partial<RecentMessageRow> = {}): RecentMessageRow {
  return {
    ts: Date.UTC(2026, 8, 9, 9, 30),
    senderId: 7,
    senderName: "Andriy",
    text: "привіт",
    kind: "text",
    photos: [],
    mediaGroupId: null,
    ...overrides,
  };
}

describe("resolveCount", () => {
  it("falls back to the default when nothing was asked", () => {
    expect(resolveCount(undefined, 300, 500)).toBe(300);
  });

  it("keeps a requested count within range", () => {
    expect(resolveCount(50, 300, 500)).toBe(50);
  });

  it("clamps above the max", () => {
    expect(resolveCount(100000, 300, 500)).toBe(500);
  });

  it("clamps a zero or negative request to 1", () => {
    expect(resolveCount(0, 300, 500)).toBe(1);
  });

  it("never returns more than the max even if the default is larger", () => {
    expect(resolveCount(undefined, 900, 500)).toBe(500);
  });
});

describe("renderTranscript", () => {
  it("prefixes each line with Kyiv time and the sender name", () => {
    // 09:30 UTC = 12:30 у Києві (літній час).
    expect(renderTranscript([row()])).toContain("[12:30] Andriy: привіт");
  });

  it("emits a day separator once per calendar day", () => {
    const lines = renderTranscript([
      row({ ts: Date.UTC(2026, 8, 8, 9, 0), text: "вчора" }),
      row({ ts: Date.UTC(2026, 8, 9, 9, 0), text: "сьогодні" }),
      row({ ts: Date.UTC(2026, 8, 9, 10, 0), text: "теж сьогодні" }),
    ]).split("\n");

    expect(lines.filter((l) => l.startsWith("---"))).toHaveLength(2);
  });

  it("marks photos without sending them", () => {
    const single = renderTranscript([
      row({ photos: [{ fileId: "f", uniqueId: "u" }], text: "оце" }),
    ]);
    expect(single).toContain("[фото] оце");

    const album = renderTranscript([
      row({
        text: "",
        photos: [
          { fileId: "f1", uniqueId: "u1" },
          { fileId: "f2", uniqueId: "u2" },
        ],
      }),
    ]);
    expect(album).toContain("[фото ×2]");
  });
});

describe("truncateForTelegram", () => {
  it("leaves short text alone", () => {
    expect(truncateForTelegram("коротко", 100)).toBe("коротко");
  });

  it("truncates with an ellipsis", () => {
    const out = truncateForTelegram("а".repeat(200), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair", () => {
    // 4 звичайні символи + емодзі (2 code units) — обріз на 6 припав би всередину пари.
    const out = truncateForTelegram("абвг😺д", 6);
    expect(out).toBe("абвг…");
  });
});

describe("buildDigestRequest", () => {
  it("puts the prompt in system without a cache breakpoint", () => {
    const { system } = buildDigestRequest([row()], "PROMPT");
    expect(system).toEqual([{ type: "text", text: "PROMPT" }]);
  });

  it("puts the transcript and the message count in the user message", () => {
    const { userMessage } = buildDigestRequest([row(), row({ text: "друге" })], "PROMPT");
    expect(userMessage).toContain("останні 2 повідомлень");
    expect(userMessage).toContain("Andriy: привіт");
    expect(userMessage).toContain("Andriy: друге");
  });
});

describe("invokeDigest", () => {
  let db: Db;

  function seed(count: number): void {
    const append = makeMessageAppender(db);
    for (let i = 0; i < count; i++) {
      append({
        chatId: 1,
        messageId: i + 1,
        ts: Date.UTC(2026, 8, 9, 9, i),
        senderId: 7,
        senderName: "Andriy",
        text: `повідомлення ${i}`,
        kind: "text",
      });
    }
  }

  function makeDeps(overrides: Partial<InvokeDigestDeps> = {}): InvokeDigestDeps {
    return {
      enabled: true,
      llmClient: makeFakeLlm().client,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 150, allowed: true }),
        usageSummary: vi.fn(),
      },
      db,
      model: "claude-sonnet-5",
      prompt: "PROMPT",
      defaultCount: 300,
      maxCount: 500,
      weight: 3,
      defaultDailyLimit: 15,
      globalDailyCap: 150,
      log: silentLog,
      startTyping: vi.fn(() => vi.fn()),
      ...overrides,
    };
  }

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("refuses when the feature flag is off", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeFakeLlm();
    seed(10);

    await invokeDigest(ctx, 999, undefined, makeDeps({ enabled: false, llmClient: llm.client }));

    expect(llm.calls).toHaveLength(0);
    expect(reply.mock.calls[0]?.[0]).toContain("вимкнений");
  });

  it("does not call the model when there is almost no history", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeFakeLlm();
    const deps = makeDeps({ llmClient: llm.client });
    seed(3);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toContain("тиша");
  });

  it("refuses when the user has less headroom than the digest weight", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeFakeLlm();
    // 13 з 15 використано — на звичайний реплай вистачило б, на дайджест ні.
    const deps = makeDeps({
      llmClient: llm.client,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 13, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 150, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    seed(10);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rate_limited", errorMessage: "user_limit" }),
    );
    expect(reply).toHaveBeenCalled();
  });

  it("refuses when the global cap has less headroom than the weight", async () => {
    const { ctx } = makeCtx();
    const llm = makeFakeLlm();
    const deps = makeDeps({
      llmClient: llm.client,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 149, cap: 150, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    seed(10);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rate_limited", errorMessage: "global_cap" }),
    );
  });

  it("lets an unlimited user through", async () => {
    const { ctx } = makeCtx();
    const llm = makeFakeLlm();
    const deps = makeDeps({
      llmClient: llm.client,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: null, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 150, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    seed(10);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(llm.calls).toHaveLength(1);
  });

  it("summarises the history and records the call with its weight", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeFakeLlm();
    const deps = makeDeps({ llmClient: llm.client });
    seed(10);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.content).toContain("повідомлення 9");
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", weight: 3, model: "claude-sonnet-5" }),
    );
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("• перше"), {
      reply_to_message_id: 999,
    });
  });

  it("honours a requested count", async () => {
    const { ctx } = makeCtx();
    const llm = makeFakeLlm();
    seed(30);

    await invokeDigest(ctx, 999, 6, makeDeps({ llmClient: llm.client }));

    const sent = String(llm.calls[0]?.content);
    expect(sent).toContain("останні 6 повідомлень");
    expect(sent).not.toContain("повідомлення 0:");
  });

  it("does not persist its own reply into messages", async () => {
    const { ctx } = makeCtx();
    seed(10);
    const before = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;

    await invokeDigest(ctx, 999, undefined, makeDeps());

    const after = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("truncates an over-long digest to the Telegram limit", async () => {
    const { ctx, reply } = makeCtx();
    seed(10);

    await invokeDigest(
      ctx,
      999,
      undefined,
      makeDeps({ llmClient: makeFakeLlm("я".repeat(5000)).client }),
    );

    expect(String(reply.mock.calls[0]?.[0]).length).toBe(4096);
  });

  it("never sends an empty message to Telegram", async () => {
    const { ctx, reply } = makeCtx();
    seed(10);

    await invokeDigest(ctx, 999, undefined, makeDeps({ llmClient: makeFakeLlm("   ").client }));

    expect(String(reply.mock.calls[0]?.[0]).trim().length).toBeGreaterThan(0);
  });

  it("shows typing while the digest is written and clears it afterwards", async () => {
    const { ctx, reply } = makeCtx();
    const stop = vi.fn();
    const startTyping = vi.fn(() => stop);
    seed(10);

    await invokeDigest(ctx, 999, undefined, makeDeps({ startTyping }));

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeGreaterThan(
      reply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not show typing when there is nothing to digest", async () => {
    const { ctx } = makeCtx();
    const startTyping = vi.fn(() => vi.fn());
    seed(3);

    await invokeDigest(ctx, 999, undefined, makeDeps({ startTyping }));

    expect(startTyping).not.toHaveBeenCalled();
  });

  it("clears typing when the model call fails", async () => {
    const { ctx } = makeCtx();
    const stop = vi.fn();
    const failing: LlmClient = {
      reply: async () => {
        throw new Error("boom");
      },
    };
    seed(10);

    await invokeDigest(
      ctx,
      999,
      undefined,
      makeDeps({ llmClient: failing, startTyping: () => stop }),
    );

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports an API failure without throwing", async () => {
    const { ctx, reply } = makeCtx();
    const failing: LlmClient = {
      reply: async () => {
        throw new Error("boom");
      },
    };
    const deps = makeDeps({ llmClient: failing });
    seed(10);

    await invokeDigest(ctx, 999, undefined, deps);

    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorMessage: "boom" }),
    );
    expect(reply.mock.calls[0]?.[0]).toContain("не вийшло");
  });
});
