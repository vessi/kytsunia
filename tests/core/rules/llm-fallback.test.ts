import { describe, expect, it } from "vitest";
import { matchLlmFallback } from "../../../src/core/rules/llm-fallback.js";
import type { MessageInput, State } from "../../../src/core/types.js";

function buildInput(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    text: "",
    messageId: 1,
    chatId: 1,
    senderId: 1,
    senderName: "x",
    ts: 0,
    kind: "text",
    ...overrides,
  };
}

function buildState(overrides: Partial<State["policy"]> = {}): State {
  return {
    dynamic: [],
    policy: { ...overrides },
    optedOutUserIds: new Set(),
  };
}

describe("matchLlmFallback", () => {
  it("returns null for messages without addressing or reply", () => {
    expect(matchLlmFallback(buildInput({ text: "просто текст" }), buildState())).toBeNull();
  });

  it("matches Кицюня address", () => {
    const result = matchLlmFallback(
      buildInput({ text: "Кицюня, що думаєш про віскі?" }),
      buildState(),
    );
    expect(result?.[0]?.kind).toBe("invoke_llm_reply");
  });

  it("matches lowercase кицюне", () => {
    const result = matchLlmFallback(buildInput({ text: "кицюне розкажи щось" }), buildState());
    expect(result?.[0]?.kind).toBe("invoke_llm_reply");
  });

  it("does not match similar but unrelated text", () => {
    expect(matchLlmFallback(buildInput({ text: "кишеня має проблему" }), buildState())).toBeNull();
  });

  it("matches reply to bot's own message", () => {
    const input = buildInput({
      text: "а чого це так?",
      replyTo: { messageId: 50, authorId: 999, authorName: "Кицюня" },
    });
    const state = buildState({ botUserId: 999 });
    const result = matchLlmFallback(input, state);
    expect(result?.[0]?.kind).toBe("invoke_llm_reply");
  });

  it("does not match reply to a different user", () => {
    const input = buildInput({
      text: "та я не з тобою",
      replyTo: { messageId: 50, authorId: 123, authorName: "Andriy" },
    });
    const state = buildState({ botUserId: 999 });
    expect(matchLlmFallback(input, state)).toBeNull();
  });

  it("ignores reply when bot user id is not configured", () => {
    const input = buildInput({
      text: "що скажеш",
      replyTo: { messageId: 50, authorId: 999, authorName: "Кицюня" },
    });
    expect(matchLlmFallback(input, buildState())).toBeNull();
  });
});
