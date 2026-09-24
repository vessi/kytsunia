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
    optedOutUserIds: new Set(),
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

describe("fixedRules: opt_out_profile", () => {
  const rule = findRule("opt_out_profile");

  it("matches plain phrase", () => {
    expect(rule.pattern.test("Кицюня, забудь мене")).toBe(true);
  });

  it("matches with exclamation", () => {
    expect(rule.pattern.test("Кицюня, забудь мене!")).toBe(true);
  });

  it("matches inside a longer sentence", () => {
    expect(rule.pattern.test("Кицюня, забудь мене будь ласка")).toBe(true);
  });

  it("does not match longer word boundary like 'менеее'", () => {
    expect(rule.pattern.test("Кицюня, забудь менеее")).toBe(false);
  });

  it("produces opt_out_profile action with sender id", () => {
    const input = buildInput({
      text: "Кицюня, забудь мене",
      messageId: 42,
      senderId: 777,
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "opt_out_profile", userId: 777, replyTo: 42 },
      ]);
    }
  });
});

describe("fixedRules: opt_in_profile", () => {
  const rule = findRule("opt_in_profile");

  it("matches with proper apostrophe ʼ", () => {
    expect(rule.pattern.test("Кицюня, запамʼятай мене")).toBe(true);
  });

  it("matches with ascii apostrophe '", () => {
    expect(rule.pattern.test("Кицюня, запам'ятай мене")).toBe(true);
  });

  it("produces opt_in_profile action", () => {
    const input = buildInput({
      text: "Кицюня, запамʼятай мене",
      messageId: 42,
      senderId: 777,
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "opt_in_profile", userId: 777, replyTo: 42 },
      ]);
    }
  });
});

describe("fixedRules: opt_out_status", () => {
  const rule = findRule("opt_out_status");

  it("matches with question mark", () => {
    expect(rule.pattern.test("Кицюня, ти мене знаєш?")).toBe(true);
  });

  it("matches without question mark", () => {
    expect(rule.pattern.test("Кицюня, ти мене знаєш")).toBe(true);
  });

  it("produces report_opt_out_status action", () => {
    const input = buildInput({
      text: "Кицюня, ти мене знаєш?",
      messageId: 42,
      senderId: 777,
    });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (m) {
      expect(rule.produce(input, m, buildState())).toEqual([
        { kind: "report_opt_out_status", userId: 777, replyTo: 42 },
      ]);
    }
  });
});

// Перевіряємо, що "забудь мене.гіф" все ще йде через forget_gif (порядок rules).
// Це гарантує, що додавання opt_out_profile нічого не зламало.
describe("fixedRules: forget_gif vs opt_out_profile precedence", () => {
  it("'забудь Х.гіф' не ловиться opt_out_profile", () => {
    const optOut = findRule("opt_out_profile");
    expect(optOut.pattern.test("Кицюня, забудь test.гіф")).toBe(false);
  });

  it("'забудь Х.стікер' не ловиться opt_out_profile", () => {
    const optOut = findRule("opt_out_profile");
    expect(optOut.pattern.test("Кицюня, забудь wow.стікер")).toBe(false);
  });
});

describe("fixedRules: digest", () => {
  const rule = findRule("digest");

  function produce(text: string) {
    const m = rule.pattern.exec(text);
    expect(m).not.toBeNull();
    if (!m) throw new Error("no match");
    return rule.produce(buildInput({ text }), m, buildState());
  }

  it("matches bare дайджест without a count", () => {
    expect(produce("Кицюня, дайджест")).toEqual([{ kind: "invoke_digest", replyTo: 100 }]);
  });

  it("matches «дай дайджест»", () => {
    expect(rule.pattern.test("Кицюня, дай дайджест")).toBe(true);
  });

  it("matches vocative and lowercase", () => {
    expect(rule.pattern.test("кицюню, дайджест")).toBe(true);
  });

  it("parses «за N»", () => {
    expect(produce("Кицюня, дайджест за 300")).toEqual([
      { kind: "invoke_digest", replyTo: 100, count: 300 },
    ]);
  });

  it("parses a bare number without «за»", () => {
    expect(produce("Кицюня, дай дайджест 50")).toEqual([
      { kind: "invoke_digest", replyTo: 100, count: 50 },
    ]);
  });

  it("omits count when the trailing token is not a number", () => {
    expect(produce("Кицюня, дайджест за сьогодні")).toEqual([
      { kind: "invoke_digest", replyTo: 100 },
    ]);
  });

  it("does not match a different word", () => {
    expect(rule.pattern.test("Кицюня, дай джем")).toBe(false);
  });
});

describe("fixedRules: web_search", () => {
  const rule = findRule("web_search");

  function produce(text: string, overrides: Partial<MessageInput> = {}) {
    const m = rule.pattern.exec(text);
    if (!m) throw new Error(`no match: ${text}`);
    return rule.produce(buildInput({ text, ...overrides }), m, buildState());
  }

  function replyTo(text?: string) {
    return {
      messageId: 50,
      authorId: 1,
      authorName: "Olha",
      ...(text !== undefined ? { text } : {}),
    };
  }

  it("takes the query typed after «пошукай»", () => {
    expect(produce("Кицюня, пошукай курс долара")).toEqual([
      { kind: "invoke_web_search", replyTo: 100, query: "курс долара" },
    ]);
  });

  it("accepts a colon and a lowercase vocative address", () => {
    expect(produce("кицюню, пошукай: курс долара")).toEqual([
      { kind: "invoke_web_search", replyTo: 100, query: "курс долара" },
    ]);
  });

  it("keeps a multiline query whole", () => {
    expect(produce("Кицюня, пошукай\nрецепт борщу\nбез буряка")[0]).toMatchObject({
      query: "рецепт борщу\nбез буряка",
    });
  });

  it("searches for the replied message when nothing is typed", () => {
    expect(produce("Кицюня, пошукай", { replyTo: replyTo("хто зараз міністр оборони?") })).toEqual([
      { kind: "invoke_web_search", replyTo: 100, query: "хто зараз міністр оборони?" },
    ]);
  });

  it("prefers the typed query over the replied message", () => {
    expect(
      produce("Кицюня, пошукай курс євро", { replyTo: replyTo("курс долара") })[0],
    ).toMatchObject({ query: "курс євро" });
  });

  it("leaves the query empty for a reply to a photo", () => {
    const photo = { ...replyTo(), photoFileId: "f", photoUniqueId: "u" };
    expect(produce("Кицюня, пошукай", { replyTo: photo })).toEqual([
      { kind: "invoke_web_search", replyTo: 100, query: "" },
    ]);
  });

  it("asks what to search when there is neither a query nor a reply", () => {
    expect(produce("Кицюня, пошукай")).toEqual([
      { kind: "reply_text", text: "Що шукати?", replyTo: 100 },
    ]);
  });

  it("does not match other forms of the verb", () => {
    expect(rule.pattern.test("Кицюня, пошукайте курс")).toBe(false);
  });
});

describe("fixedRules: usage_report", () => {
  const rule = findRule("usage_report");
  const admin = buildState({ policy: { adminUserId: 300 } });

  it("defaults to 7 days for the admin", () => {
    const input = buildInput({ text: "Кицюня, звіт" });
    const m = rule.pattern.exec(input.text);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(rule.produce(input, m, admin)).toEqual([
      { kind: "report_usage", replyTo: 100, days: 7 },
    ]);
  });

  it("parses an explicit day count and clamps it to 90", () => {
    for (const [text, days] of [
      ["Кицюня, звіт 30", 30],
      ["Кицюня, звіт 365", 90],
      ["Кицюня, звіт 0", 1],
    ] as const) {
      const input = buildInput({ text });
      const m = rule.pattern.exec(text);
      expect(m).not.toBeNull();
      if (!m) return;
      expect(rule.produce(input, m, admin)).toEqual([{ kind: "report_usage", replyTo: 100, days }]);
    }
  });

  it("is silently ignored for non-admins", () => {
    const input = buildInput({ text: "Кицюня, звіт", senderId: 301 });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([]);
    expect(rule.produce(input, m, buildState())).toEqual([]);
  });

  it("does not match words that merely start with звіт", () => {
    expect(rule.pattern.test("Кицюня, звітність це нудно")).toBe(false);
  });
});

describe("fixedRules: special_instruction_add", () => {
  const rule = findRule("special_instruction_add");
  const admin = buildState({ policy: { adminUserId: 300 } });

  it("takes everything after the command, including line breaks", () => {
    const text = "Кицюня, спеціальна інструкція\nНе згадуй котів.\nІ собак теж.";
    const input = buildInput({ text });
    const m = rule.pattern.exec(text);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(rule.produce(input, m, admin)).toEqual([
      {
        kind: "add_special_instruction",
        replyTo: 100,
        chatId: 200,
        text: "Не згадуй котів.\nІ собак теж.",
      },
    ]);
  });

  it("accepts a colon or space after the command", () => {
    for (const text of [
      "Кицюня, спеціальна інструкція: сьогодні свято",
      "Кицюня, спеціальна інструкція сьогодні свято",
    ]) {
      const m = rule.pattern.exec(text);
      if (!m) throw new Error("no match");
      expect(rule.produce(buildInput({ text }), m, admin)).toEqual([
        { kind: "add_special_instruction", replyTo: 100, chatId: 200, text: "сьогодні свято" },
      ]);
    }
  });

  it("falls back to the replied-to message when no text is typed", () => {
    const input = buildInput({
      text: "Кицюня, спеціальна інструкція",
      replyTo: { messageId: 5, authorId: 300, authorName: "Test", text: " Хвали Олю. " },
    });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([
      { kind: "add_special_instruction", replyTo: 100, chatId: 200, text: "Хвали Олю." },
    ]);
  });

  it("asks for the text when there is none", () => {
    const input = buildInput({ text: "Кицюня, спеціальна інструкція" });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([
      { kind: "reply_text", text: "Яка інструкція?", replyTo: 100 },
    ]);
  });

  it("is silently ignored for non-admins", () => {
    const input = buildInput({ text: "Кицюня, спеціальна інструкція: щось", senderId: 301 });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([]);
    expect(rule.produce(input, m, buildState())).toEqual([]);
  });

  it("does not match the plural list command", () => {
    expect(rule.pattern.test("Кицюня, спеціальні інструкції")).toBe(false);
  });
});

describe("fixedRules: special_instructions_list", () => {
  const rule = findRule("special_instructions_list");
  const admin = buildState({ policy: { adminUserId: 300 } });

  it("produces the list action for the admin", () => {
    for (const text of ["Кицюня, спеціальні інструкції", "Кицюня, спеціальні інструкції?"]) {
      const m = rule.pattern.exec(text);
      if (!m) throw new Error("no match");
      expect(rule.produce(buildInput({ text }), m, admin)).toEqual([
        { kind: "list_special_instructions", replyTo: 100, chatId: 200 },
      ]);
    }
  });

  it("is silently ignored for non-admins", () => {
    const input = buildInput({ text: "Кицюня, спеціальні інструкції", senderId: 301 });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([]);
  });
});

describe("fixedRules: special_instruction_remove", () => {
  const rule = findRule("special_instruction_remove");
  const admin = buildState({ policy: { adminUserId: 300 } });

  it("parses the id, with or without #", () => {
    for (const text of ["Кицюня, забудь інструкцію 12", "Кицюня, забудь інструкцію #12"]) {
      const m = rule.pattern.exec(text);
      if (!m) throw new Error("no match");
      expect(rule.produce(buildInput({ text }), m, admin)).toEqual([
        { kind: "remove_special_instruction", replyTo: 100, chatId: 200, id: 12 },
      ]);
    }
  });

  it("is silently ignored for non-admins", () => {
    const input = buildInput({ text: "Кицюня, забудь інструкцію 12", senderId: 301 });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([]);
  });

  it("does not steal «забудь мене» or «забудь x.гіф»", () => {
    expect(rule.pattern.test("Кицюня, забудь мене")).toBe(false);
    expect(rule.pattern.test("Кицюня, забудь інструкцію.гіф")).toBe(false);
  });
});

describe("fixedRules: chat_model", () => {
  const rule = findRule("chat_model");
  const admin = buildState({ policy: { adminUserId: 300 } });
  const base = { replyTo: 100, chatId: 200 };

  function run(text: string, state = admin) {
    const m = rule.pattern.exec(text);
    if (!m) throw new Error(`no match: ${text}`);
    return rule.produce(buildInput({ text }), m, state);
  }

  it("shows the current model without an argument", () => {
    for (const text of ["Кицюня, модель", "Кицюня, модель?", "кицюню, модель!"]) {
      expect(run(text)).toEqual([{ kind: "show_chat_model", ...base }]);
    }
  });

  it("passes the requested model through as typed", () => {
    expect(run("Кицюня, модель opus")).toEqual([
      { kind: "set_chat_model", ...base, model: "opus" },
    ]);
    expect(run("Кицюня, модель: claude-sonnet-5.")).toEqual([
      { kind: "set_chat_model", ...base, model: "claude-sonnet-5" },
    ]);
  });

  it("resets on «скинь» and «за замовчуванням»", () => {
    for (const text of ["Кицюня, модель скинь", "Кицюня, модель за замовчуванням"]) {
      expect(run(text)).toEqual([{ kind: "reset_chat_model", ...base }]);
    }
  });

  it("is silently ignored for non-admins", () => {
    const input = buildInput({ text: "Кицюня, модель opus", senderId: 301 });
    const m = rule.pattern.exec(input.text);
    if (!m) throw new Error("no match");
    expect(rule.produce(input, m, admin)).toEqual([]);
    expect(rule.produce(input, m, buildState())).toEqual([]);
  });

  it("does not match words that merely start with модель", () => {
    expect(rule.pattern.test("Кицюня, модельєр це професія")).toBe(false);
  });
});
