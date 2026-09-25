import type { Context } from "grammy";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LlmClient,
  LlmReply,
  ReplyOptions,
  SystemContent,
  UserContent,
} from "../../../src/shell/llm/anthropic.js";
import { type InvokeLlmDeps, invokeLlmReply, withSources } from "../../../src/shell/llm/invoke.js";
import type { PhotoFetcher } from "../../../src/shell/llm/telegram-photos.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

type CapturedReply = { system: SystemContent; content: UserContent };

function makeFakeLlm(): { client: LlmClient; calls: CapturedReply[] } {
  const calls: CapturedReply[] = [];
  const client: LlmClient = {
    reply: async (system, userMessage): Promise<LlmReply> => {
      calls.push({ system, content: userMessage });
      return {
        text: "ok",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    },
  };
  return { client, calls };
}

function makeCtx(overrides: {
  chatId?: number;
  userId?: number;
  userName?: string;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string }>;
  mediaGroupId?: string;
  replyToMediaGroupId?: string;
}): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
  // ctx.reply повертає Message-подібний обʼєкт з msg_id і date — в проді ми
  // використовуємо це для appendMessage(bot reply).
  const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
  const message: Record<string, unknown> = {
    message_id: 999,
    chat: { id: overrides.chatId ?? 1 },
    from: { id: overrides.userId ?? 7, first_name: overrides.userName ?? "Andriy" },
    date: 0,
  };
  if (overrides.text) message.text = overrides.text;
  if (overrides.caption) message.caption = overrides.caption;
  if (overrides.photo) message.photo = overrides.photo;
  if (overrides.mediaGroupId) message.media_group_id = overrides.mediaGroupId;
  if (overrides.replyToMediaGroupId) {
    message.reply_to_message = { media_group_id: overrides.replyToMediaGroupId };
  }
  const ctx = {
    message,
    chat: message.chat,
    from: message.from,
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function makeBaseDeps(overrides: Partial<InvokeLlmDeps> = {}): InvokeLlmDeps {
  const db = openTestDb();
  const llmCallStore = {
    record: vi.fn(),
    checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 100, allowed: true }),
    checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 1000, allowed: true }),
    usageSummary: vi.fn(),
    countChatDigestsToday: vi.fn(() => 0),
  };
  const regularsStore = {
    upsert: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    listByChat: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
    removeAllForUser: vi.fn(),
    setManualNotes: vi.fn(),
  };
  const fetcher: PhotoFetcher = vi.fn().mockResolvedValue({ mime: "image/jpeg", base64: "B64" });
  return {
    llmClient: makeFakeLlm().client,
    llmCallStore,
    db,
    model: "test",
    digestModel: "digest-test",
    chatSettings: {
      getModel: vi.fn(() => null),
      setModel: vi.fn(),
      clearModel: vi.fn(),
      getPersona: vi.fn(() => null),
      setPersona: vi.fn(),
      clearPersona: vi.fn(),
      getDigestMaxCount: vi.fn(() => null),
      setDigestMaxCount: vi.fn(),
      clearDigestMaxCount: vi.fn(),
      getDigestModel: vi.fn(() => null),
      setDigestModel: vi.fn(),
      clearDigestModel: vi.fn(),
    },
    persona: () => "P",
    defaultDailyLimit: 100,
    globalDailyCap: 1000,
    recentContextSize: 10,
    regularsStore,
    instructionStore: { list: vi.fn(() => []), add: vi.fn(), remove: vi.fn() },
    rng: () => 0,
    log: silentLog,
    visionEnabled: true,
    photoFetcher: fetcher,
    maxPhotosTotal: 8,
    maxPhotosPerAlbum: 5,
    albumDebounceMs: 1500,
    threadDepth: 5,
    ttlMs: 0, // тести явно вмикають TTL коли треба
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => 1_000_000,
    appendMessage: vi.fn(),
    botUserId: 9999,
    botName: "Кицюня",
    startTyping: vi.fn(() => vi.fn()),
    searchEnabled: true,
    searchMaxUses: 3,
    searchWeight: 3,
    searchPrompt: "SEARCH",
    ...overrides,
  };
}

describe("invokeLlmReply: vision", () => {
  let dbsToClose: Array<{ close: () => void }> = [];

  beforeEach(() => {
    dbsToClose = [];
  });

  afterEach(() => {
    for (const d of dbsToClose) d.close();
  });

  it("debounces when trigger has media_group_id", async () => {
    const { client, calls } = makeFakeLlm();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeBaseDeps({ llmClient: client, sleep });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    append({
      chatId: 1,
      messageId: 999,
      ts: 100,
      senderId: 7,
      senderName: "Andriy",
      text: "глянь",
      kind: "photo",
      photoFileId: "f1",
      photoUniqueId: "u1",
      mediaGroupId: "alb",
    });

    const { ctx } = makeCtx({
      caption: "глянь",
      photo: [{ file_id: "f1", file_unique_id: "u1" }],
      mediaGroupId: "alb",
    });
    await invokeLlmReply(ctx, 999, deps);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(calls).toHaveLength(1);
  });

  it("does not debounce when no album anywhere", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeBaseDeps({ sleep });
    dbsToClose.push(deps.db);
    const { ctx } = makeCtx({ text: "hi" });
    await invokeLlmReply(ctx, 999, deps);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("debounces when reply target has media_group_id", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeBaseDeps({ sleep });
    dbsToClose.push(deps.db);
    const { ctx } = makeCtx({ text: "що це", replyToMediaGroupId: "g" });
    await invokeLlmReply(ctx, 999, deps);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("sends single photo when trigger has one and no album", async () => {
    const { client, calls } = makeFakeLlm();
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B64" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ llmClient: client, photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    const { ctx } = makeCtx({
      caption: "?",
      photo: [{ file_id: "fff", file_unique_id: "uuu" }],
    });
    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("fff", "uuu");
    const content = calls[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("expands trigger album from DB", async () => {
    const { client, calls } = makeFakeLlm();
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ llmClient: client, photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    // DB має 3 фото з одним media_group_id; все вже є до debounce.
    const append = makeMessageAppender(deps.db);
    for (let i = 0; i < 3; i++) {
      append({
        chatId: 1,
        messageId: 999 + i,
        ts: 100 + i,
        senderId: 7,
        senderName: "A",
        text: i === 0 ? "альбом" : "",
        kind: "photo",
        photoFileId: `f${i}`,
        photoUniqueId: `u${i}`,
        mediaGroupId: "alb",
      });
    }

    const { ctx } = makeCtx({
      caption: "альбом",
      photo: [{ file_id: "f0", file_unique_id: "u0" }],
      mediaGroupId: "alb",
    });
    await invokeLlmReply(ctx, 999, deps);

    // 3 фото з альбому
    expect(fetcher).toHaveBeenCalledTimes(3);
    const blocks = calls[0]?.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(3);
  });

  it("caps trigger album to maxPhotosPerAlbum", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher, maxPhotosPerAlbum: 3 });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    for (let i = 0; i < 7; i++) {
      append({
        chatId: 1,
        messageId: 999 + i,
        ts: 100 + i,
        senderId: 7,
        senderName: "A",
        text: i === 0 ? "x" : "",
        kind: "photo",
        photoFileId: `f${i}`,
        photoUniqueId: `u${i}`,
        mediaGroupId: "big",
      });
    }
    const { ctx } = makeCtx({
      caption: "x",
      photo: [{ file_id: "f0", file_unique_id: "u0" }],
      mediaGroupId: "big",
    });
    await invokeLlmReply(ctx, 999, deps);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("text-only message does NOT pull photos from history", async () => {
    // Регресія: раніше historical photos підтягувались на кожен reply і модель
    // фіксувалась на них (recency-photo-bias).
    const { client, calls } = makeFakeLlm();
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ llmClient: client, photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    // В історії є фото
    const append = makeMessageAppender(deps.db);
    for (let i = 0; i < 3; i++) {
      append({
        chatId: 1,
        messageId: 100 + i,
        ts: 100 + i,
        senderId: 7,
        senderName: "A",
        text: "",
        kind: "photo",
        photoFileId: `hist${i}`,
        photoUniqueId: `huid${i}`,
      });
    }
    // Тригер — звичайний текст без фото і без reply
    const { ctx } = makeCtx({ text: "ну і що там з погодою" });
    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).not.toHaveBeenCalled();
    expect(typeof calls[0]?.content).toBe("string");
  });

  it("includes reply target photo even when current message is text-only", async () => {
    const { client, calls } = makeFakeLlm();
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ llmClient: client, photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    // reply_to_message з фото — конструюємо ctx вручну
    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 999,
        chat: { id: 1 },
        from: { id: 7, first_name: "A" },
        date: 0,
        text: "це що за порода?",
        reply_to_message: {
          message_id: 50,
          photo: [
            { file_id: "rs", file_unique_id: "ru_s" },
            { file_id: "rl", file_unique_id: "ru_l" },
          ],
        },
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("rl", "ru_l"); // найбільший
    const blocks = calls[0]?.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("expands reply target album from DB", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    // Альбом в DB
    const append = makeMessageAppender(deps.db);
    for (let i = 0; i < 3; i++) {
      append({
        chatId: 1,
        messageId: 50 + i,
        ts: 50 + i,
        senderId: 8,
        senderName: "Anna",
        text: i === 0 ? "ось" : "",
        kind: "photo",
        photoFileId: `ra${i}`,
        photoUniqueId: `rau${i}`,
        mediaGroupId: "ralbum",
      });
    }

    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 999,
        chat: { id: 1 },
        from: { id: 7, first_name: "A" },
        date: 0,
        text: "?",
        reply_to_message: {
          message_id: 50,
          media_group_id: "ralbum",
          photo: [{ file_id: "ra0", file_unique_id: "rau0" }],
        },
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 999, deps);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("dedupes when trigger and reply share a photo", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 999,
        chat: { id: 1 },
        from: { id: 7, first_name: "A" },
        date: 0,
        caption: "ну",
        photo: [{ file_id: "shared", file_unique_id: "shared_u" }],
        reply_to_message: {
          message_id: 50,
          photo: [{ file_id: "shared", file_unique_id: "shared_u" }],
        },
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 999, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("tolerates failed photo fetch (skips, does not throw)", async () => {
    const { client, calls } = makeFakeLlm();
    const fetcher = vi.fn(async (fileId: string) => {
      if (fileId === "bad") throw new Error("oops");
      return { mime: "image/jpeg", base64: "B" };
    }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ llmClient: client, photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    append({
      chatId: 1,
      messageId: 999,
      ts: 100,
      senderId: 7,
      senderName: "A",
      text: "альбом",
      kind: "photo",
      photoFileId: "good",
      photoUniqueId: "ug",
      mediaGroupId: "a",
    });
    append({
      chatId: 1,
      messageId: 1000,
      ts: 101,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "bad",
      photoUniqueId: "ub",
      mediaGroupId: "a",
    });
    const { ctx, reply } = makeCtx({
      caption: "альбом",
      photo: [{ file_id: "good", file_unique_id: "ug" }],
      mediaGroupId: "a",
    });
    await invokeLlmReply(ctx, 999, deps);

    // Одне впало, одне дійшло — reply все одно відправлено
    expect(reply).toHaveBeenCalledWith("ok", { reply_to_message_id: 999 });
    const blocks = calls[0]?.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("when visionEnabled=false: no fetches, string content", async () => {
    const { client, calls } = makeFakeLlm();
    const fetcher = vi.fn() as unknown as PhotoFetcher;
    const deps = makeBaseDeps({
      llmClient: client,
      photoFetcher: fetcher,
      visionEnabled: false,
    });
    dbsToClose.push(deps.db);

    const { ctx } = makeCtx({
      caption: "?",
      photo: [{ file_id: "f", file_unique_id: "u" }],
    });
    await invokeLlmReply(ctx, 999, deps);
    expect(fetcher).not.toHaveBeenCalled();
    expect(typeof calls[0]?.content).toBe("string");
  });

  it("rate-limited path skips vision entirely", async () => {
    const fetcher = vi.fn() as unknown as PhotoFetcher;
    const deps = makeBaseDeps({
      photoFetcher: fetcher,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 100, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 100, cap: 100, allowed: false }),
        usageSummary: vi.fn(),
      },
    });
    dbsToClose.push(deps.db);
    const { ctx } = makeCtx({
      caption: "?",
      photo: [{ file_id: "f", file_unique_id: "u" }],
    });
    await invokeLlmReply(ctx, 999, deps);
    expect(fetcher).not.toHaveBeenCalled();
  });

  // ─── Reply-chain traversal & TTL fallback ─────────────────────────────

  it("persists bot reply to DB after sending", async () => {
    const appendMock = vi.fn();
    const deps = makeBaseDeps({ appendMessage: appendMock, botUserId: 9999, botName: "Кицюня" });
    dbsToClose.push(deps.db);

    const { ctx } = makeCtx({ text: "привіт" });
    await invokeLlmReply(ctx, 999, deps);

    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 12345,
        senderId: 9999,
        senderName: "Кицюня",
        text: "ok",
        kind: "text",
        replyTo: expect.objectContaining({ messageId: 999, authorId: 7 }),
      }),
    );
  });

  it("traverses reply chain to find photo (user → bot → user-with-photo)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    // 1. Користувач закинув фото з caption
    append({
      chatId: 1,
      messageId: 100,
      ts: 100,
      senderId: 7,
      senderName: "Andriy",
      text: "що це?",
      kind: "photo",
      photoFileId: "fp",
      photoUniqueId: "up",
    });
    // 2. Кицюня відповіла (її repl на 100)
    append({
      chatId: 1,
      messageId: 101,
      ts: 101,
      senderId: 9999,
      senderName: "Кицюня",
      text: "це Зеленський",
      kind: "text",
      replyTo: { messageId: 100, authorId: 7, authorName: "Andriy" },
    });
    // 3. Користувач питає далі (на Кицюнин 101) — наш trigger
    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 102,
        chat: { id: 1 },
        from: { id: 7, first_name: "Andriy" },
        date: 0,
        text: "а що ще там видно?",
        reply_to_message: { message_id: 101 }, // reply на Кицюню (текст, без фото)
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 102, deps);

    // Chain має знайти фото з msg 100
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("fp", "up");
  });

  it("traverses chain across multiple bot/user hops", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    // фото
    append({
      chatId: 1,
      messageId: 100,
      ts: 100,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "fp",
      photoUniqueId: "up",
    });
    // 4 ітерації бот ↔ юзер без фото
    for (let i = 0; i < 4; i++) {
      const id = 101 + i;
      const replyToId = 100 + i;
      append({
        chatId: 1,
        messageId: id,
        ts: 100 + i + 1,
        senderId: i % 2 === 0 ? 9999 : 7,
        senderName: i % 2 === 0 ? "Кицюня" : "A",
        text: `t${i}`,
        kind: "text",
        replyTo: {
          messageId: replyToId,
          authorId: i % 2 === 0 ? 7 : 9999,
          authorName: "x",
        },
      });
    }

    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 200,
        chat: { id: 1 },
        from: { id: 7, first_name: "A" },
        date: 0,
        text: "?",
        reply_to_message: { message_id: 104 }, // 4 hops from photo (104→103→102→101→100)
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 200, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("fp", "up");
  });

  it("respects threadDepth limit (does not find photo too deep)", async () => {
    const fetcher = vi.fn() as unknown as PhotoFetcher;
    const deps = makeBaseDeps({ photoFetcher: fetcher, threadDepth: 2 });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    // фото в самому корені
    append({
      chatId: 1,
      messageId: 100,
      ts: 100,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "fp",
      photoUniqueId: "up",
    });
    // 5 текстових повідомлень в chain
    for (let i = 0; i < 5; i++) {
      append({
        chatId: 1,
        messageId: 101 + i,
        ts: 100 + i + 1,
        senderId: 7,
        senderName: "A",
        text: "x",
        kind: "text",
        replyTo: { messageId: 100 + i, authorId: 7, authorName: "A" },
      });
    }

    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    const ctx = {
      message: {
        message_id: 200,
        chat: { id: 1 },
        from: { id: 7, first_name: "A" },
        date: 0,
        text: "?",
        reply_to_message: { message_id: 105 }, // фото на 5 hops, depth=2
      },
      chat: { id: 1 },
      from: { id: 7 },
      reply,
    } as unknown as Context;

    await invokeLlmReply(ctx, 200, deps);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("TTL fallback finds recent photo when no trigger or chain", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const NOW = 1_000_000;
    const deps = makeBaseDeps({
      photoFetcher: fetcher,
      ttlMs: 60_000,
      now: () => NOW,
    });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    // Фото 30 сек тому — в межах TTL
    append({
      chatId: 1,
      messageId: 100,
      ts: NOW - 30_000,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "recent",
      photoUniqueId: "recent_u",
    });

    const { ctx } = makeCtx({ text: "що це?" });
    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("recent", "recent_u");
  });

  it("TTL fallback ignores photos outside the window", async () => {
    const fetcher = vi.fn() as unknown as PhotoFetcher;
    const NOW = 1_000_000;
    const deps = makeBaseDeps({
      photoFetcher: fetcher,
      ttlMs: 60_000,
      now: () => NOW,
    });
    dbsToClose.push(deps.db);

    const append = makeMessageAppender(deps.db);
    // Фото 5 хв тому — поза TTL
    append({
      chatId: 1,
      messageId: 100,
      ts: NOW - 5 * 60_000,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "old",
      photoUniqueId: "old_u",
    });

    const { ctx } = makeCtx({ text: "що це?" });
    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("TTL fallback skipped when trigger has photo", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ mime: "image/jpeg", base64: "B" }) as unknown as PhotoFetcher;
    const NOW = 1_000_000;
    const deps = makeBaseDeps({
      photoFetcher: fetcher,
      ttlMs: 60_000,
      now: () => NOW,
    });
    dbsToClose.push(deps.db);

    // Recent photo в TTL — не повинно мікшуватись з trigger.
    const append = makeMessageAppender(deps.db);
    append({
      chatId: 1,
      messageId: 100,
      ts: NOW - 10_000,
      senderId: 7,
      senderName: "A",
      text: "",
      kind: "photo",
      photoFileId: "recent",
      photoUniqueId: "recent_u",
    });

    const { ctx } = makeCtx({
      caption: "ось нове",
      photo: [{ file_id: "newone", file_unique_id: "newone_u" }],
    });
    await invokeLlmReply(ctx, 999, deps);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("newone", "newone_u");
  });
});

describe("invokeLlmReply: reply thread", () => {
  const opened: InvokeLlmDeps[] = [];
  afterEach(() => {
    for (const d of opened.splice(0)) d.db.close();
  });

  function threadCtx(replyToMessage: Record<string, unknown>, text = "а чому саме так?") {
    const reply = vi.fn().mockResolvedValue({ message_id: 12345, date: 0 });
    return {
      message: {
        message_id: 500,
        chat: { id: 1 },
        from: { id: 7, first_name: "Andriy" },
        date: 0,
        text,
        reply_to_message: replyToMessage,
      },
      chat: { id: 1 },
      from: { id: 7, first_name: "Andriy" },
      reply,
    } as unknown as Context;
  }

  it("puts the reply chain into the system tail, target last", async () => {
    const llm = makeFakeLlm();
    const deps = makeBaseDeps({ llmClient: llm.client });
    opened.push(deps);
    const append = makeMessageAppender(deps.db);
    // Давня розмова, що вже випала б із recent, якби чат був жвавий.
    append({
      chatId: 1,
      messageId: 100,
      ts: 100,
      senderId: 7,
      senderName: "Andriy",
      text: "що взяти з віскі?",
      kind: "text",
    });
    append({
      chatId: 1,
      messageId: 101,
      ts: 101,
      senderId: 9999,
      senderName: "Кицюня",
      text: "Lagavulin 16, не дякуй.",
      kind: "text",
      replyTo: { messageId: 100, authorId: 7, authorName: "Andriy" },
    });

    const ctx = threadCtx({
      message_id: 101,
      from: { id: 9999, first_name: "Кицюня" },
      text: "Lagavulin 16, не дякуй.",
    });
    await invokeLlmReply(ctx, 500, deps);

    const system = llm.calls[0]?.system as Array<{ text: string }>;
    const tail = system[1]?.text ?? "";
    expect(tail).toContain("Гілка, на яку відповідає користувач");
    expect(tail).toContain("Andriy: що взяти з віскі?\nКицюня: Lagavulin 16, не дякуй.");
    // Сама персона лишається чистим кешованим префіксом.
    expect(system[0]?.text).toBe("P");
  });

  it("still shows the target when the DB has never seen it", async () => {
    const llm = makeFakeLlm();
    const deps = makeBaseDeps({ llmClient: llm.client });
    opened.push(deps);

    const ctx = threadCtx({
      message_id: 42,
      from: { id: 8, first_name: "Olha" },
      text: "а я б Ardbeg брала",
    });
    await invokeLlmReply(ctx, 500, deps);

    const system = llm.calls[0]?.system as Array<{ text: string }>;
    expect(system[1]?.text).toContain("Olha: а я б Ardbeg брала");
  });

  it("adds no thread section without a reply", async () => {
    const llm = makeFakeLlm();
    const deps = makeBaseDeps({ llmClient: llm.client });
    opened.push(deps);
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, deps);

    const system = llm.calls[0]?.system as Array<{ text: string }>;
    expect(system.map((b) => b.text).join("\n")).not.toContain("Гілка");
  });
});

describe("invokeLlmReply: web search", () => {
  const opened: InvokeLlmDeps[] = [];

  afterEach(() => {
    for (const d of opened.splice(0)) d.db.close();
  });

  function searchDeps(overrides: Partial<InvokeLlmDeps> = {}): InvokeLlmDeps {
    const deps = makeBaseDeps({ model: "claude-sonnet-5", persona: () => "PERSONA", ...overrides });
    opened.push(deps);
    return deps;
  }

  function makeSearchLlm(overrides: Partial<LlmReply> = {}) {
    const calls: Array<{
      system: SystemContent;
      content: UserContent;
      maxTokens: number | undefined;
      options: ReplyOptions | undefined;
    }> = [];
    const client: LlmClient = {
      reply: async (system, content, _model, maxTokens, options) => {
        calls.push({ system, content, maxTokens, options });
        return {
          text: "Курс 44,55.",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearchRequests: 1,
          sources: [],
          ...overrides,
        };
      },
    };
    return { client, calls };
  }

  const SEARCH = { search: { query: "курс долара" } };

  it("attaches the web search tool with max_uses and a bigger token budget", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client, searchMaxUses: 2 }), SEARCH);

    expect(llm.calls[0]?.options?.tools?.[0]).toMatchObject({
      type: "web_search_20250305",
      max_uses: 2,
    });
    expect(llm.calls[0]?.maxTokens).toBeGreaterThan(500);
  });

  it("does not attach tools to a normal reply", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }));

    expect(llm.calls[0]?.options).toBeUndefined();
  });

  it("appends the search prompt to the persona", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({ llmClient: llm.client, searchPrompt: "SEARCH RULES" });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    const system = llm.calls[0]?.system as Array<{ text: string }>;
    expect(system[0]?.text).toBe("PERSONA\n\nSEARCH RULES");
  });

  it("puts this chat's admin instructions into the persona block, before the search prompt", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const list = vi.fn((chatId: number) =>
      chatId === 1
        ? [
            { id: 1, chatId, text: "Не згадуй котів.", createdAt: 0 },
            { id: 4, chatId, text: "Перший рядок.\nДругий рядок.", createdAt: 0 },
          ]
        : [],
    );
    const deps = searchDeps({
      llmClient: llm.client,
      searchPrompt: "SEARCH RULES",
      instructionStore: { list, add: vi.fn(), remove: vi.fn() },
    });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(list).toHaveBeenCalledWith(1);
    const system = llm.calls[0]?.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]?.text).toBe(
      "PERSONA\n\nСпеціальні інструкції від адміна для цього чату. Якщо вони суперечать правилам вище — виконуй інструкції:\n- Не згадуй котів.\n- Перший рядок.\n  Другий рядок.\n\nSEARCH RULES",
    );
    expect(system[0]?.cache_control).toBeDefined();
  });

  it("puts the query into the message the model sees", async () => {
    const llm = makeSearchLlm();
    // Reply-кейс: сам тригер без запиту, запит узято з повідомлення, на яке відповіли.
    const { ctx } = makeCtx({ text: "Кицюня, пошукай" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }), SEARCH);

    expect(llm.calls[0]?.content).toBe("Andriy: Кицюня, пошукай: курс долара");
  });

  it("keeps the trigger text when the query is empty", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, пошукай" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }), {
      search: { query: "" },
    });

    expect(llm.calls[0]?.content).toBe("Andriy: Кицюня, пошукай");
  });

  it("answers without calling the model when search is disabled", async () => {
    const llm = makeSearchLlm();
    const { ctx, reply } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({ llmClient: llm.client, searchEnabled: false });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0]).toContain("вимкнений");
  });

  it("refuses a search when the user has fewer slots left than its weight", async () => {
    const llm = makeSearchLlm();
    const { ctx, reply } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({
      llmClient: llm.client,
      searchWeight: 3,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 13, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 1000, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rate_limited", errorMessage: "user_limit", weight: 3 }),
    );
    expect(reply.mock.calls[0]?.[0]).toContain("Пошук коштує 3");
  });

  it("still lets a normal reply through with the same headroom", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    const deps = searchDeps({
      llmClient: llm.client,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 13, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 1000, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    await invokeLlmReply(ctx, 999, deps);

    expect(llm.calls).toHaveLength(1);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", weight: 1 }),
    );
  });

  it("refuses a search when the global cap has less headroom than its weight", async () => {
    const llm = makeSearchLlm();
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({
      llmClient: llm.client,
      searchWeight: 3,
      llmCallStore: {
        record: vi.fn(),
        checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 15, allowed: true }),
        checkGlobalRate: vi.fn().mockReturnValue({ used: 998, cap: 1000, allowed: true }),
        usageSummary: vi.fn(),
      },
    });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rate_limited", errorMessage: "global_cap" }),
    );
  });

  it("records the search weight and includes the per-search fee in the cost", async () => {
    const llm = makeSearchLlm({ inputTokens: 0, outputTokens: 0, webSearchRequests: 2 });
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({ llmClient: llm.client, searchWeight: 3 });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", weight: 3, costUsd: expect.closeTo(0.02, 5) }),
    );
  });

  it("appends at most two sources and disables link previews", async () => {
    const llm = makeSearchLlm({
      sources: [
        { url: "https://bank.gov.ua/rate", title: "НБУ" },
        { url: "https://minfin.com.ua/currency", title: "Мінфін" },
        { url: "https://third.example/rate", title: null },
      ],
    });
    const { ctx, reply } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }), SEARCH);

    const [sentText, sentOptions] = reply.mock.calls[0] ?? [];
    expect(sentText).toBe(
      "Курс 44,55.\n\nДжерела:\nhttps://bank.gov.ua/rate\nhttps://minfin.com.ua/currency",
    );
    expect(sentOptions).toMatchObject({ link_preview_options: { is_disabled: true } });
  });

  it("stores the reply in history without the sources", async () => {
    const llm = makeSearchLlm({ sources: [{ url: "https://bank.gov.ua/rate", title: "НБУ" }] });
    const { ctx } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    const deps = searchDeps({ llmClient: llm.client });
    await invokeLlmReply(ctx, 999, deps, SEARCH);

    expect(deps.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Курс 44,55." }),
    );
  });

  it("falls back to a short answer when the search ends without text", async () => {
    const llm = makeSearchLlm({ text: "", stopReason: "pause_turn" });
    const { ctx, reply } = makeCtx({ text: "Кицюня, пошукай курс долара" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }), SEARCH);

    expect(reply.mock.calls[0]?.[0]).toBe("Нічого путнього не знайшла.");
  });

  it("never sends an empty normal reply either", async () => {
    const llm = makeSearchLlm({ text: "  " });
    const { ctx, reply } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, searchDeps({ llmClient: llm.client }));

    expect(String(reply.mock.calls[0]?.[0]).trim()).not.toBe("");
  });
});

describe("invokeLlmReply: per-chat model", () => {
  const opened: InvokeLlmDeps[] = [];

  afterEach(() => {
    for (const d of opened.splice(0)) d.db.close();
  });

  function deps(overrides: Partial<InvokeLlmDeps>): InvokeLlmDeps {
    const d = makeBaseDeps(overrides);
    opened.push(d);
    return d;
  }

  function makeLlm() {
    const calls: Array<{ system: SystemContent; model: string }> = [];
    const client: LlmClient = {
      reply: async (system, _content, model) => {
        calls.push({ system, model });
        return {
          text: "ок",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    return { client, calls };
  }

  it("uses the chat override for the call, the record and the persona", async () => {
    const llm = makeLlm();
    const persona = vi.fn((model: string, digestModel: string) => `P:${model}/${digestModel}`);
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    const d = deps({
      llmClient: llm.client,
      model: "claude-sonnet-5",
      persona,
      chatSettings: {
        getModel: vi.fn((chatId: number) => (chatId === 1 ? "claude-opus-5" : null)),
        setModel: vi.fn(),
        clearModel: vi.fn(),
        getPersona: vi.fn(() => null),
        setPersona: vi.fn(),
        clearPersona: vi.fn(),
        getDigestMaxCount: vi.fn(() => null),
        setDigestMaxCount: vi.fn(),
        clearDigestMaxCount: vi.fn(),
        getDigestModel: vi.fn(() => null),
        setDigestModel: vi.fn(),
        clearDigestModel: vi.fn(),
      },
    });
    await invokeLlmReply(ctx, 999, d);

    expect(llm.calls[0]?.model).toBe("claude-opus-5");
    // Модель відповідей не тягне за собою модель дайджесту: та лишається дефолтною.
    expect(persona).toHaveBeenCalledWith("claude-opus-5", "digest-test", null);
    const system = llm.calls[0]?.system as Array<{ text: string }>;
    expect(system[0]?.text).toBe("P:claude-opus-5/digest-test");
    expect(d.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5", status: "ok" }),
    );
  });

  it("hands the chat's persona override to the persona builder", async () => {
    const llm = makeLlm();
    const persona = vi.fn(
      (model: string, digestModel: string, character: string | null) =>
        `${model}|${digestModel}|${character}`,
    );
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    const d = deps({
      llmClient: llm.client,
      model: "claude-sonnet-5",
      persona,
      chatSettings: {
        getModel: vi.fn(() => null),
        setModel: vi.fn(),
        clearModel: vi.fn(),
        getPersona: vi.fn((chatId: number) => (chatId === 1 ? "Ти сумна сова." : null)),
        setPersona: vi.fn(),
        clearPersona: vi.fn(),
        getDigestMaxCount: vi.fn(() => null),
        setDigestMaxCount: vi.fn(),
        clearDigestMaxCount: vi.fn(),
        getDigestModel: vi.fn(() => null),
        setDigestModel: vi.fn(),
        clearDigestModel: vi.fn(),
      },
    });
    await invokeLlmReply(ctx, 999, d);

    expect(persona).toHaveBeenCalledWith("claude-sonnet-5", "digest-test", "Ти сумна сова.");
    const system = llm.calls[0]?.system as Array<{ text: string }>;
    expect(system[0]?.text).toBe("claude-sonnet-5|digest-test|Ти сумна сова.");
  });

  it("tells the persona about the chat's own digest model", async () => {
    const llm = makeLlm();
    const persona = vi.fn((model: string, digestModel: string) => `P:${model}/${digestModel}`);
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    const d = deps({ llmClient: llm.client, model: "claude-sonnet-5", persona });
    (d.chatSettings.getDigestModel as ReturnType<typeof vi.fn>).mockReturnValue("claude-haiku-4-5");
    await invokeLlmReply(ctx, 999, d);
    expect(persona).toHaveBeenCalledWith("claude-sonnet-5", "claude-haiku-4-5", null);
  });

  it("falls back to the default model without an override", async () => {
    const llm = makeLlm();
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, deps({ llmClient: llm.client, model: "claude-sonnet-5" }));
    expect(llm.calls[0]?.model).toBe("claude-sonnet-5");
  });
});

describe("invokeLlmReply: typing indicator", () => {
  const opened: InvokeLlmDeps[] = [];

  afterEach(() => {
    for (const d of opened.splice(0)) d.db.close();
  });

  function deps(overrides: Partial<InvokeLlmDeps>): InvokeLlmDeps {
    const d = makeBaseDeps(overrides);
    opened.push(d);
    return d;
  }

  it("shows typing while the model works and clears it after replying", async () => {
    const stop = vi.fn();
    const startTyping = vi.fn(() => stop);
    const { ctx, reply } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, deps({ startTyping }));

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeGreaterThan(
      reply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("clears typing when the model call fails", async () => {
    const stop = vi.fn();
    const failing: LlmClient = {
      reply: async () => {
        throw new Error("boom");
      },
    };
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(ctx, 999, deps({ llmClient: failing, startTyping: () => stop }));

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not show typing for a rate-limited request", async () => {
    const startTyping = vi.fn(() => vi.fn());
    const { ctx } = makeCtx({ text: "Кицюня, привіт" });
    await invokeLlmReply(
      ctx,
      999,
      deps({
        startTyping,
        llmCallStore: {
          record: vi.fn(),
          checkUserRate: vi.fn().mockReturnValue({ used: 100, limit: 100, allowed: false }),
          checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 1000, allowed: true }),
          usageSummary: vi.fn(),
        },
      }),
    );

    expect(startTyping).not.toHaveBeenCalled();
  });
});

describe("withSources", () => {
  it("returns the text unchanged when there are no sources", () => {
    expect(withSources("Курс 44,55.", [])).toBe("Курс 44,55.");
  });

  it("uses the singular label for a single source", () => {
    expect(withSources("Курс 44,55.", [{ url: "https://bank.gov.ua/rate", title: "НБУ" }])).toBe(
      "Курс 44,55.\n\nДжерело:\nhttps://bank.gov.ua/rate",
    );
  });
});
