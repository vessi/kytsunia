import { describe, expect, it } from "vitest";
import { match } from "../../src/core/matcher.js";
import type { MessageInput, State } from "../../src/core/types.js";

function input(overrides: Partial<MessageInput>): MessageInput {
  return {
    text: "",
    messageId: 1,
    chatId: -100,
    senderId: 42,
    senderName: "Troll",
    ts: 0,
    kind: "text",
    ...overrides,
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    dynamic: [{ pattern: "кіт.гіф", type: "gif", fileId: "f" }],
    policy: { botUserId: 9999, botUsername: "kytsynia_bot" },
    optedOutUserIds: new Set(),
    ignoredUserIds: new Set(),
    ...overrides,
  };
}

describe("match: ignored users", () => {
  const ignored = state({ ignoredUserIds: new Set([42]) });

  it("produces nothing for an ignored user, whatever they say", () => {
    for (const text of [
      "Кицюня!",
      "Кицюня, ти людина чи компʼютер?",
      "кіт.гіф",
      "Кицюня, дайджест",
      "@kytsynia_bot привіт",
      "Кицюня, які знаєш гіфки?",
    ]) {
      expect(match(input({ text }), ignored)).toBeNull();
    }
  });

  it("ignores replies to the bot and private messages from an ignored user too", () => {
    expect(
      match(
        input({ text: "а?", replyTo: { messageId: 2, authorId: 9999, authorName: "Кицюня" } }),
        ignored,
      ),
    ).toBeNull();
    expect(match(input({ text: "привіт", chatId: 42 }), ignored)).toBeNull();
  });

  it("still lets an ignored user opt out of profiling", () => {
    expect(match(input({ text: "Кицюня, забудь мене" }), ignored)).toEqual([
      { kind: "opt_out_profile", userId: 42, replyTo: 1 },
    ]);
  });

  it("does not affect other users", () => {
    expect(match(input({ text: "Кицюня!", senderId: 43 }), ignored)).toEqual([
      { kind: "react", emoji: "🤔" },
    ]);
  });
});
