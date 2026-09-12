import { afterEach, describe, expect, it } from "vitest";
import type { MessageInput } from "../../../src/core/types.js";
import { collectThread, replyTargetFromMessage } from "../../../src/shell/llm/thread.js";
import { makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

const CHAT = 1;

function msg(overrides: Partial<MessageInput> & { messageId: number }): MessageInput {
  return {
    text: "",
    chatId: CHAT,
    senderId: 7,
    senderName: "Andriy",
    ts: overrides.messageId,
    kind: "text",
    ...overrides,
  };
}

describe("collectThread", () => {
  const dbs: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function setup() {
    const db = openTestDb();
    dbs.push(db);
    return { db, append: makeMessageAppender(db) };
  }

  it("returns the Telegram target alone when the DB knows nothing about it", () => {
    const { db } = setup();
    const thread = collectThread(
      db,
      CHAT,
      { messageId: 50, senderName: "Кицюня", text: "бери Lagavulin" },
      5,
    );
    expect(thread).toEqual([{ senderName: "Кицюня", text: "бери Lagavulin" }]);
  });

  it("walks reply_to_id back through bot and user messages, oldest first", () => {
    const { db, append } = setup();
    append(msg({ messageId: 100, text: "що взяти з віскі?" }));
    append(
      msg({
        messageId: 101,
        senderId: 9999,
        senderName: "Кицюня",
        text: "Lagavulin",
        replyTo: { messageId: 100, authorId: 7, authorName: "Andriy" },
      }),
    );
    append(
      msg({
        messageId: 102,
        text: "а не задорого?",
        replyTo: { messageId: 101, authorId: 9999, authorName: "Кицюня" },
      }),
    );
    append(
      msg({
        messageId: 103,
        senderId: 9999,
        senderName: "Кицюня",
        text: "залежить від гаманця",
        replyTo: { messageId: 102, authorId: 7, authorName: "Andriy" },
      }),
    );

    const thread = collectThread(
      db,
      CHAT,
      { messageId: 103, senderName: "Кицюня", text: "залежить від гаманця" },
      10,
    );
    expect(thread.map((m) => m.text)).toEqual([
      "що взяти з віскі?",
      "Lagavulin",
      "а не задорого?",
      "залежить від гаманця",
    ]);
    expect(thread[0]?.senderName).toBe("Andriy");
    expect(thread[1]?.senderName).toBe("Кицюня");
  });

  it("caps the thread at maxDepth counting the target itself", () => {
    const { db, append } = setup();
    append(msg({ messageId: 1, text: "один" }));
    append(
      msg({ messageId: 2, text: "два", replyTo: { messageId: 1, authorId: 7, authorName: "A" } }),
    );
    append(
      msg({ messageId: 3, text: "три", replyTo: { messageId: 2, authorId: 7, authorName: "A" } }),
    );

    const thread = collectThread(db, CHAT, { messageId: 3, senderName: "Andriy", text: "три" }, 2);
    expect(thread.map((m) => m.text)).toEqual(["два", "три"]);
  });

  it("returns nothing when maxDepth is 0", () => {
    const { db } = setup();
    expect(collectThread(db, CHAT, { messageId: 3, senderName: "A", text: "x" }, 0)).toEqual([]);
  });

  it("stops at a gap in the DB instead of failing", () => {
    const { db, append } = setup();
    // 2 відповідає на 1, але 1 в DB немає (старіше за історію).
    append(
      msg({ messageId: 2, text: "два", replyTo: { messageId: 1, authorId: 7, authorName: "A" } }),
    );
    const thread = collectThread(db, CHAT, { messageId: 2, senderName: "Andriy", text: "два" }, 5);
    expect(thread.map((m) => m.text)).toEqual(["два"]);
  });

  it("marks photos and stickers instead of dropping them", () => {
    const { db, append } = setup();
    append(msg({ messageId: 1, kind: "photo", photoFileId: "f", photoUniqueId: "u" }));
    append(
      msg({
        messageId: 2,
        kind: "sticker",
        replyTo: { messageId: 1, authorId: 7, authorName: "A" },
      }),
    );
    append(
      msg({
        messageId: 3,
        kind: "photo",
        text: "дивись",
        photoFileId: "f2",
        photoUniqueId: "u2",
        replyTo: { messageId: 2, authorId: 7, authorName: "A" },
      }),
    );
    const thread = collectThread(
      db,
      CHAT,
      { messageId: 3, senderName: "Andriy", text: "[фото] дивись" },
      5,
    );
    expect(thread.map((m) => m.text)).toEqual(["[фото]", "[стікер]", "[фото] дивись"]);
  });

  it("does not cross chats", () => {
    const { db, append } = setup();
    append(msg({ messageId: 1, chatId: 2, text: "чужий чат" }));
    append(
      msg({ messageId: 2, text: "два", replyTo: { messageId: 1, authorId: 7, authorName: "A" } }),
    );
    const thread = collectThread(db, CHAT, { messageId: 2, senderName: "Andriy", text: "два" }, 5);
    expect(thread.map((m) => m.text)).toEqual(["два"]);
  });
});

describe("replyTargetFromMessage", () => {
  it("uses text, or caption with a photo marker, or a kind marker", () => {
    const base = { message_id: 5, date: 0, chat: { id: 1, type: "group" as const, title: "t" } };
    const from = { id: 7, is_bot: false, first_name: "Olha" };
    // biome-ignore lint/suspicious/noExplicitAny: мінімальні Telegram-обʼєкти для тесту
    const as = (m: unknown) => replyTargetFromMessage(m as any);

    expect(as({ ...base, from, text: "привіт" })).toEqual({
      messageId: 5,
      senderName: "Olha",
      text: "привіт",
    });
    expect(as({ ...base, from, caption: "глянь", photo: [{ file_id: "f" }] }).text).toBe(
      "[фото] глянь",
    );
    expect(as({ ...base, from, photo: [{ file_id: "f" }] }).text).toBe("[фото]");
    expect(as({ ...base, from, sticker: { file_id: "s" } }).text).toBe("[стікер]");
    expect(as({ ...base, from, animation: { file_id: "a" } }).text).toBe("[гіфка]");
  });
});
