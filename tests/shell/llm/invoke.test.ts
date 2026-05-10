import type { Context } from "grammy";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmReply, UserContent } from "../../../src/shell/llm/anthropic.js";
import { type InvokeLlmDeps, invokeLlmReply } from "../../../src/shell/llm/invoke.js";
import type { PhotoFetcher } from "../../../src/shell/llm/telegram-photos.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

type CapturedReply = { system: string; content: UserContent };

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
    persona: "P",
    defaultDailyLimit: 100,
    globalDailyCap: 1000,
    recentContextSize: 10,
    profilesLimit: 5,
    regularsStore,
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
