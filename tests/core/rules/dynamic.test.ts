import { describe, expect, it } from "vitest";
import { matchDynamic } from "../../../src/core/rules/dynamic.js";
import type { MessageInput, State } from "../../../src/core/types.js";

function buildInput(text: string): MessageInput {
  return {
    text,
    messageId: 1,
    chatId: 100,
    senderId: 1,
    senderName: "x",
    ts: 0,
    kind: "text",
  };
}

describe("matchDynamic", () => {
  it("returns null on empty state", () => {
    expect(
      matchDynamic(buildInput("test.гіф"), {
        dynamic: [],
        policy: {},
        optedOutUserIds: new Set(),
      }),
    ).toBeNull();
  });

  it("matches a gif rule and produces send_animation", () => {
    const state: State = {
      dynamic: [{ pattern: "test.гіф", type: "gif", fileId: "FX" }],
      policy: {},
      optedOutUserIds: new Set(),
    };
    const result = matchDynamic(buildInput("test.гіф"), state);
    expect(result).toEqual([{ kind: "send_animation", chatId: 100, fileId: "FX" }]);
  });

  it("matches a sticker rule and produces send_sticker", () => {
    const state: State = {
      dynamic: [{ pattern: "wow.стікер", type: "sticker", fileId: "SX" }],
      policy: {},
      optedOutUserIds: new Set(),
    };
    const result = matchDynamic(buildInput("wow.стікер"), state);
    expect(result).toEqual([{ kind: "send_sticker", chatId: 100, fileId: "SX" }]);
  });

  it("returns first match when multiple match", () => {
    const state: State = {
      dynamic: [
        { pattern: "test.гіф", type: "gif", fileId: "FIRST" },
        { pattern: "test.стікер", type: "sticker", fileId: "SECOND" },
      ],
      policy: {},
      optedOutUserIds: new Set(),
    };
    const result = matchDynamic(buildInput("test.гіф"), state);
    expect(result?.[0]?.kind).toBe("send_animation");
  });
});
