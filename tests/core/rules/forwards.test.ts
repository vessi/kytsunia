import { describe, expect, it } from "vitest";
import { matchForward } from "../../../src/core/rules/forwards.js";
import type { MessageInput } from "../../../src/core/types.js";

function buildInput(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    text: "",
    messageId: 100,
    chatId: 200,
    senderId: 300,
    senderName: "Test",
    ts: 1_000_000,
    kind: "text",
    ...overrides,
  };
}

describe("matchForward", () => {
  it("returns null for non-forward message", () => {
    expect(matchForward(buildInput())).toBeNull();
  });

  it("returns null for forward from unknown channel", () => {
    const input = buildInput({
      kind: "forward",
      forwardOrigin: { kind: "channel", chatId: -999999 },
    });
    expect(matchForward(input)).toBeNull();
  });

  it("returns send_animation for known gif channel", () => {
    const input = buildInput({
      kind: "forward",
      forwardOrigin: { kind: "channel", chatId: -1001049320233 },
      messageId: 50,
      chatId: 100,
    });
    const result = matchForward(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.kind).toBe("send_animation");
    if (result?.[0]?.kind === "send_animation") {
      expect(result[0].chatId).toBe(100);
      expect(result[0].replyTo).toBe(50);
    }
  });

  it("returns send_sticker for known sticker channel", () => {
    const input = buildInput({
      kind: "forward",
      forwardOrigin: { kind: "channel", chatId: -1001360737249 },
    });
    const result = matchForward(input);
    expect(result?.[0]?.kind).toBe("send_sticker");
  });
});
