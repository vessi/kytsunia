import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageInput } from "../../../src/core/types.js";
import { getRecentMessages, makeMessageAppender } from "../../../src/shell/storage/messages.js";
import { openTestDb } from "../../helpers/db.js";

function msg(overrides: Partial<MessageInput> & Pick<MessageInput, "messageId">): MessageInput {
  const { messageId } = overrides;
  return {
    chatId: 1,
    ts: messageId * 1000,
    senderId: 100,
    senderName: "Olha",
    text: "",
    kind: "text",
    ...overrides,
  };
}

describe("messages storage", () => {
  let db: Database.Database;
  let append: ReturnType<typeof makeMessageAppender>;

  beforeEach(() => {
    db = openTestDb();
    append = makeMessageAppender(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores and reads back text-only messages", () => {
    append(msg({ messageId: 1, text: "привіт" }));
    append(msg({ messageId: 2, text: "як справи" }));
    const recent = getRecentMessages(db, 1, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.text).toBe("привіт");
    expect(recent[1]?.text).toBe("як справи");
  });

  it("includes photo-only messages (no caption) in recent", () => {
    append(
      msg({
        messageId: 1,
        kind: "photo",
        photoFileId: "f1",
        photoUniqueId: "u1",
      }),
    );
    append(msg({ messageId: 2, text: "ха" }));
    const recent = getRecentMessages(db, 1, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.photos).toHaveLength(1);
    expect(recent[0]?.photos[0]?.fileId).toBe("f1");
    expect(recent[0]?.photos[0]?.uniqueId).toBe("u1");
  });

  it("groups album messages into one logical row with multiple photos", () => {
    // Альбом з 3 фото. Caption на першому.
    append(
      msg({
        messageId: 10,
        kind: "photo",
        photoFileId: "f10",
        photoUniqueId: "u10",
        mediaGroupId: "g1",
        text: "дивіться що знайшов",
      }),
    );
    append(
      msg({
        messageId: 11,
        kind: "photo",
        photoFileId: "f11",
        photoUniqueId: "u11",
        mediaGroupId: "g1",
      }),
    );
    append(
      msg({
        messageId: 12,
        kind: "photo",
        photoFileId: "f12",
        photoUniqueId: "u12",
        mediaGroupId: "g1",
      }),
    );

    const recent = getRecentMessages(db, 1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("дивіться що знайшов");
    expect(recent[0]?.photos.map((p) => p.fileId)).toEqual(["f10", "f11", "f12"]);
    expect(recent[0]?.mediaGroupId).toBe("g1");
  });

  it("excludes message by msg id", () => {
    append(msg({ messageId: 1, text: "a" }));
    append(msg({ messageId: 2, text: "b" }));
    const recent = getRecentMessages(db, 1, 10, 2);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("a");
  });

  it("respects logical limit (album counts as one)", () => {
    // 5 текстових + альбом з 4 фото → 6 логічних
    for (let i = 1; i <= 5; i++) {
      append(msg({ messageId: i, text: `t${i}` }));
    }
    for (let i = 6; i <= 9; i++) {
      append(
        msg({
          messageId: i,
          kind: "photo",
          photoFileId: `f${i}`,
          photoUniqueId: `u${i}`,
          mediaGroupId: "alb",
          text: i === 6 ? "caption" : "",
        }),
      );
    }
    const recent = getRecentMessages(db, 1, 6);
    expect(recent).toHaveLength(6);
    // Альбом має бути в результаті (як один рядок)
    const album = recent.find((r) => r.mediaGroupId === "alb");
    expect(album).toBeDefined();
    expect(album?.photos).toHaveLength(4);
  });

  it("expands album siblings even if only one fit in initial fetch", () => {
    // Багато текстових + великий альбом — перевіряємо що сіблінги все ж добираються
    for (let i = 1; i <= 100; i++) {
      append(msg({ messageId: i, text: `t${i}` }));
    }
    for (let i = 101; i <= 110; i++) {
      append(
        msg({
          messageId: i,
          kind: "photo",
          photoFileId: `f${i}`,
          photoUniqueId: `u${i}`,
          mediaGroupId: "big",
          text: i === 101 ? "альбом" : "",
        }),
      );
    }
    const recent = getRecentMessages(db, 1, 5);
    const album = recent.find((r) => r.mediaGroupId === "big");
    expect(album).toBeDefined();
    expect(album?.photos).toHaveLength(10);
  });

  it("returns chronological order (oldest → newest)", () => {
    append(msg({ messageId: 1, text: "first", ts: 1000 }));
    append(msg({ messageId: 2, text: "second", ts: 2000 }));
    append(msg({ messageId: 3, text: "third", ts: 3000 }));
    const recent = getRecentMessages(db, 1, 10);
    expect(recent.map((r) => r.text)).toEqual(["first", "second", "third"]);
  });
});
