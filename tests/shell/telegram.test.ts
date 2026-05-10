import type { Context } from "grammy";
import { describe, expect, it } from "vitest";
import { toMessageInput } from "../../src/shell/telegram.js";

// Мінімально необхідний моковий Context. Тести фокусуються на toMessageInput,
// тож решту полів не вигадуємо.
function makeCtx(message: unknown): Context {
  return { message } as Context;
}

describe("toMessageInput", () => {
  it("returns null when no message", () => {
    expect(toMessageInput(makeCtx(undefined))).toBeNull();
  });

  it("captures basic text message", () => {
    const ctx = makeCtx({
      message_id: 42,
      chat: { id: 100 },
      from: { id: 7, first_name: "Andriy" },
      date: 1000,
      text: "привіт",
    });
    const input = toMessageInput(ctx);
    expect(input).toMatchObject({
      messageId: 42,
      chatId: 100,
      senderId: 7,
      senderName: "Andriy",
      text: "привіт",
      kind: "text",
      ts: 1000_000,
    });
    expect(input?.photoFileId).toBeUndefined();
    expect(input?.mediaGroupId).toBeUndefined();
  });

  it("captures largest photo size and unique id", () => {
    const ctx = makeCtx({
      message_id: 1,
      chat: { id: 100 },
      from: { id: 7, first_name: "Andriy" },
      date: 1,
      caption: "глянь",
      photo: [
        { file_id: "small", file_unique_id: "u" },
        { file_id: "medium", file_unique_id: "u" },
        { file_id: "large", file_unique_id: "u_large" },
      ],
    });
    const input = toMessageInput(ctx);
    expect(input?.photoFileId).toBe("large");
    expect(input?.photoUniqueId).toBe("u_large");
    expect(input?.text).toBe("глянь"); // caption fall-back
    expect(input?.kind).toBe("photo");
  });

  it("captures media_group_id", () => {
    const ctx = makeCtx({
      message_id: 1,
      chat: { id: 100 },
      from: { id: 7, first_name: "A" },
      date: 1,
      photo: [{ file_id: "f", file_unique_id: "u" }],
      media_group_id: "ALBUM_42",
    });
    const input = toMessageInput(ctx);
    expect(input?.mediaGroupId).toBe("ALBUM_42");
  });

  it("captures reply_to photo and media_group_id", () => {
    const ctx = makeCtx({
      message_id: 2,
      chat: { id: 100 },
      from: { id: 7, first_name: "A" },
      date: 1,
      text: "що це?",
      reply_to_message: {
        message_id: 1,
        from: { id: 8, first_name: "Olha" },
        photo: [
          { file_id: "rs", file_unique_id: "ru" },
          { file_id: "rl", file_unique_id: "ru_l" },
        ],
        media_group_id: "G7",
      },
    });
    const input = toMessageInput(ctx);
    expect(input?.replyTo?.photoFileId).toBe("rl");
    expect(input?.replyTo?.photoUniqueId).toBe("ru_l");
    expect(input?.replyTo?.mediaGroupId).toBe("G7");
  });

  it("does not set photo fields on text-only messages", () => {
    const ctx = makeCtx({
      message_id: 1,
      chat: { id: 100 },
      from: { id: 7, first_name: "A" },
      date: 1,
      text: "hi",
    });
    const input = toMessageInput(ctx);
    expect(input?.photoFileId).toBeUndefined();
    expect(input?.photoUniqueId).toBeUndefined();
    expect(input?.mediaGroupId).toBeUndefined();
  });
});
