import { describe, expect, it } from "vitest";
import { fixedRules } from "../../../src/core/rules/fixed.js";
import type { MessageInput, State } from "../../../src/core/types.js";

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

function buildState(overrides: Partial<State> = {}): State {
  return {
    dynamic: [],
    policy: {},
    ...overrides,
  };
}

function findRule(name: string) {
  const rule = fixedRules.find((r) => r.name === name);
  if (!rule) throw new Error(`rule ${name} not found`);
  return rule;
}

// існуючі describe блоки лишаються, тільки кожен виклик produce
// тепер має третій аргумент buildState():
//   rule.produce(input, m, buildState())

describe("fixedRules: address_react", () => {
  const rule = findRule("address_react");

  it("matches Кицюня!", () => {
    expect(rule.pattern.test("Кицюня!")).toBe(true);
  });

  it("matches Кицюню! vocative", () => {
    expect(rule.pattern.test("Кицюню!")).toBe(true);
  });

  it("matches with lowercase к", () => {
    expect(rule.pattern.test("кицюня!")).toBe(true);
  });

  it("does not match without exclamation", () => {
    expect(rule.pattern.test("Кицюня")).toBe(false);
  });

  it("produces react action", () => {
    const input = buildInput({ text: "Кицюня!" });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([{ kind: "react", emoji: "🤔" }]);
    }
  });
});

describe("fixedRules: human_or_computer", () => {
  const rule = findRule("human_or_computer");

  it("produces reply_text with replyTo to current message", () => {
    const input = buildInput({ text: "Кицюня, ти людина чи компʼютер?", messageId: 555 });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "reply_text", text: "Я компʼютер!", replyTo: 555 },
      ]);
    }
  });
});

describe("fixedRules: alerts_map", () => {
  const rule = findRule("alerts_map");

  it("matches with question mark", () => {
    expect(rule.pattern.test("Кицюня, де тривога?")).toBe(true);
  });

  it("matches without question mark", () => {
    expect(rule.pattern.test("Кицюня, де тривога")).toBe(true);
  });

  it("produces send_photo_url with alerts URL", () => {
    const input = buildInput({ text: "Кицюня, де тривога?", chatId: 123 });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        {
          kind: "send_photo_url",
          chatId: 123,
          url: "https://alerts.com.ua/map.png",
          filename: "alerts.png",
        },
      ]);
    }
  });
});

describe("fixedRules: discipline", () => {
  const rule = findRule("discipline");

  it("targets reply_to message when present", () => {
    const input = buildInput({
      text: "Кицюня, виховуй",
      messageId: 999,
      replyTo: { messageId: 555, authorId: 1, authorName: "x" },
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "discipline_with_random_insult", replyTo: 555 },
      ]);
    }
  });

  it("targets self when no reply", () => {
    const input = buildInput({ text: "Кицюня, виховуй", messageId: 999 });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "discipline_with_random_insult", replyTo: 999 },
      ]);
    }
  });
});

describe("fixedRules: ack_save", () => {
  const rule = findRule("ack_save");

  it("matches and produces snarky reply", () => {
    const input = buildInput({ text: "Кицюня, запишись!", messageId: 42 });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        {
          kind: "reply_text",
          text: "Дядя, ти дурак? Автоматично зберігаюсь вже",
          replyTo: 42,
        },
      ]);
    }
  });
});

describe("fixedRules: say_in_chat", () => {
  const rule = findRule("say_in_chat");

  it("works for admin sender", () => {
    const input = buildInput({
      text: "Кицюня, скажи в -100123 привіт всім",
      senderId: 100,
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      const result = rule.produce(input, m, buildState({ policy: { adminUserId: 100 } }));
      expect(result).toEqual([
        { kind: "send_message_to_chat", chatId: -100123, text: "привіт всім" },
      ]);
    }
  });

  it("silently ignores non-admin sender", () => {
    const input = buildInput({
      text: "Кицюня, скажи в -100123 привіт",
      senderId: 999,
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState({ policy: { adminUserId: 100 } }))).toEqual([]);
    }
  });

  it("rejects when no admin configured", () => {
    const input = buildInput({
      text: "Кицюня, скажи в -100123 привіт",
      senderId: 100,
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState({ policy: {} }))).toEqual([]);
    }
  });

  it("returns empty when chat_id missing even for admin", () => {
    const input = buildInput({
      text: "Кицюня, скажи в - привіт",
      senderId: 100,
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState({ policy: { adminUserId: 100 } }))).toEqual([]);
    }
  });
});

describe("fixedRules: list_all", () => {
  const rule = findRule("list_all");

  it("lists fixed and dynamic patterns", () => {
    const input = buildInput({ text: "Кицюня, список!", messageId: 77 });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      const result = rule.produce(
        input,
        m,
        buildState({
          dynamic: [{ pattern: "тест\\.гіф", type: "gif", fileId: "x" }],
        }),
      );
      expect(result).toHaveLength(1);
      const action = result[0];
      expect(action?.kind).toBe("reply_text");
      if (action?.kind === "reply_text") {
        expect(action.text).toContain("ицюн");
        expect(action.text).toContain("тест\\.гіф");
        expect(action.replyTo).toBe(77);
      }
    }
  });
});

describe("fixedRules: register_gif", () => {
  const rule = findRule("register_gif");

  it("registers a gif rule when reply has animation", () => {
    const input = buildInput({
      text: "Кицюня, запиши як test.гіф",
      messageId: 99,
      replyTo: { messageId: 50, authorId: 1, authorName: "x", animationFileId: "ANIM_FILE" },
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      const result = rule.produce(input, m, buildState());
      expect(result).toEqual([
        {
          kind: "register_dynamic_rule",
          spec: { pattern: "test.гіф", type: "gif", fileId: "ANIM_FILE" },
        },
        { kind: "reply_text", text: "Записала як test", replyTo: 99 },
      ]);
    }
  });

  it("returns empty when no animation in reply", () => {
    const input = buildInput({
      text: "Кицюня, запиши як test.гіф",
      replyTo: { messageId: 50, authorId: 1, authorName: "x" },
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([]);
    }
  });
});

describe("fixedRules: forget_gif", () => {
  const rule = findRule("forget_gif");

  it("returns 'Такого правила немає' when rule absent", () => {
    const input = buildInput({ text: "Кицюня, забудь test.гіф", messageId: 99 });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "reply_text", text: "Такого правила немає", replyTo: 99 },
      ]);
    }
  });

  it("forgets and acks when rule present", () => {
    const input = buildInput({ text: "Кицюня, забудь test.гіф", messageId: 99 });
    const state = buildState({
      dynamic: [{ pattern: "test.гіф", type: "gif", fileId: "X" }],
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, state)).toEqual([
        { kind: "forget_dynamic_rule", pattern: "test.гіф" },
        { kind: "reply_text", text: "Забула", replyTo: 99 },
      ]);
    }
  });
});

describe("fixedRules: list_gifs", () => {
  const rule = findRule("list_gifs");

  it("returns 'Список порожній' when no gifs", () => {
    const input = buildInput({ text: "Кицюня, які знаєш гіфки?", messageId: 1 });
    const m = rule.pattern.exec(input.text);
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "reply_text", text: "Список порожній", replyTo: 1 },
      ]);
    }
  });

  it("lists gif names without extension", () => {
    const input = buildInput({ text: "Кицюня, які знаєш гіфки?", messageId: 1 });
    const state = buildState({
      dynamic: [
        { pattern: "test.гіф", type: "gif", fileId: "X" },
        { pattern: "another.гіф", type: "gif", fileId: "Y" },
        { pattern: "skip.стікер", type: "sticker", fileId: "Z" },
      ],
    });
    const m = rule.pattern.exec(input.text);
    if (m) {
      const result = rule.produce(input, m, state);
      const action = result[0];
      if (action?.kind === "reply_text") {
        expect(action.text).toBe("test\nanother");
      }
    }
  });
});
