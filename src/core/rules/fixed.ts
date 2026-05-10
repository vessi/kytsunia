import type { Action, MessageInput, State } from "../types.js";

export type FixedRule = {
  name: string;
  pattern: RegExp;
  produce: (input: MessageInput, match: RegExpExecArray, state: State) => Action[];
};

export const fixedRules: FixedRule[] = [
  {
    name: "address_react",
    pattern: /(К|к)ицюн(я|ю)!/,
    produce: () => [{ kind: "react", emoji: "🤔" }],
  },
  {
    name: "human_or_computer",
    pattern: /(К|к)ицюн(я|ю), ти людина чи компʼютер\?/,
    produce: (input) => [{ kind: "reply_text", text: "Я компʼютер!", replyTo: input.messageId }],
  },
  {
    name: "alerts_map",
    pattern: /(К|к)ицюн(я|ю), де тривога\??/,
    produce: (input) => [
      {
        kind: "send_photo_url",
        chatId: input.chatId,
        url: "https://alerts.com.ua/map.png",
        filename: "alerts.png",
      },
    ],
  },
  {
    name: "discipline",
    pattern: /(К|к)ицюн(я|ю), виховуй/,
    produce: (input) => [
      {
        kind: "discipline_with_random_insult",
        replyTo: input.replyTo?.messageId ?? input.messageId,
      },
    ],
  },
  {
    name: "ack_save",
    pattern: /(К|к)ицюн(я|ю), запишись!/,
    produce: (input) => [
      {
        kind: "reply_text",
        text: "Дядя, ти дурак? Автоматично зберігаюсь вже",
        replyTo: input.messageId,
      },
    ],
  },
  {
    name: "say_in_chat",
    pattern: /(К|к)ицюн(я|ю), скажи в (-\d*) (.*)/,
    produce: (input, match, state) => {
      // Admin only. Тиха ігнорація для не-адмінів — не розкриваємо існування команди.
      if (state.policy.adminUserId !== input.senderId) return [];
      const chatIdStr = match[3];
      const text = match[4];
      if (!chatIdStr || !text) return [];
      const chatId = Number.parseInt(chatIdStr, 10);
      if (Number.isNaN(chatId)) return [];
      return [{ kind: "send_message_to_chat", chatId, text }];
    },
  },
  {
    name: "list_all",
    pattern: /(К|к)ицюн(я|ю), список!/,
    produce: (input, _match, state) => {
      const fixedPatterns = fixedRules.map((r) => r.pattern.source);
      const dynamicPatterns = state.dynamic.map((d) => d.pattern);
      const all = [...fixedPatterns, ...dynamicPatterns].join("\n");
      return [{ kind: "reply_text", text: all, replyTo: input.messageId }];
    },
  },
  {
    name: "register_gif",
    pattern: /(К|к)ицюн(я|ю), запиши як (.+)\.гіф/,
    produce: (input, match) => {
      const name = match[3];
      const fileId = input.replyTo?.animationFileId;
      if (!name || !fileId) return [];
      return [
        { kind: "register_dynamic_rule", spec: { pattern: `${name}.гіф`, type: "gif", fileId } },
        { kind: "reply_text", text: `Записала як ${name}`, replyTo: input.messageId },
      ];
    },
  },
  {
    name: "register_sticker",
    pattern: /(К|к)ицюн(я|ю), запиши як (.+)\.стікер/,
    produce: (input, match) => {
      const name = match[3];
      const fileId = input.replyTo?.stickerFileId;
      if (!name || !fileId) return [];
      return [
        {
          kind: "register_dynamic_rule",
          spec: { pattern: `${name}.стікер`, type: "sticker", fileId },
        },
        { kind: "reply_text", text: `Записала як ${name}`, replyTo: input.messageId },
      ];
    },
  },
  {
    name: "forget_gif",
    pattern: /(К|к)ицюн(я|ю), забудь (.+)\.гіф/,
    produce: (input, match, state) => {
      const name = match[3];
      if (!name) return [];
      const pattern = `${name}.гіф`;
      const exists = state.dynamic.some((d) => d.pattern === pattern);
      if (!exists) {
        return [{ kind: "reply_text", text: "Такого правила немає", replyTo: input.messageId }];
      }
      return [
        { kind: "forget_dynamic_rule", pattern },
        { kind: "reply_text", text: "Забула", replyTo: input.messageId },
      ];
    },
  },
  {
    name: "forget_sticker",
    pattern: /(К|к)ицюн(я|ю), забудь (.+)\.стікер/,
    produce: (input, match, state) => {
      const name = match[3];
      if (!name) return [];
      const pattern = `${name}.стікер`;
      const exists = state.dynamic.some((d) => d.pattern === pattern);
      if (!exists) {
        return [{ kind: "reply_text", text: "Такого правила немає", replyTo: input.messageId }];
      }
      return [
        { kind: "forget_dynamic_rule", pattern },
        { kind: "reply_text", text: "Забула", replyTo: input.messageId },
      ];
    },
  },
  {
    // Має йти після forget_gif / forget_sticker, щоб "забудь Х.гіф/.стікер"
    // забирали ті правила раніше. Термінатор у класі — бо \b у JS regex
    // ASCII-only і не спрацьовує між кириличними літерами.
    name: "opt_out_profile",
    pattern: /(К|к)ицюн(я|ю), забудь мене(?:[!?.\s,]|$)/,
    produce: (input) => [
      { kind: "opt_out_profile", userId: input.senderId, replyTo: input.messageId },
    ],
  },
  {
    // Підтримуємо обидва апострофи: ʼ (правильний) і ' (типовий ASCII).
    name: "opt_in_profile",
    pattern: /(К|к)ицюн(я|ю), запам(ʼ|')ятай мене(?:[!?.\s,]|$)/,
    produce: (input) => [
      { kind: "opt_in_profile", userId: input.senderId, replyTo: input.messageId },
    ],
  },
  {
    name: "opt_out_status",
    pattern: /(К|к)ицюн(я|ю), ти мене знаєш\??/,
    produce: (input) => [
      { kind: "report_opt_out_status", userId: input.senderId, replyTo: input.messageId },
    ],
  },
  {
    name: "list_gifs",
    pattern: /(К|к)ицюн(я|ю), які знаєш гіфки\?/,
    produce: (input, _match, state) => {
      const names = state.dynamic
        .filter((d) => d.type === "gif")
        .map((d) => d.pattern.replace(".гіф", ""));
      const text = names.length > 0 ? names.join("\n") : "Список порожній";
      return [{ kind: "reply_text", text, replyTo: input.messageId }];
    },
  },
  {
    name: "list_stickers",
    pattern: /(К|к)ицюн(я|ю), які знаєш стікери\?/,
    produce: (input, _match, state) => {
      const names = state.dynamic
        .filter((d) => d.type === "sticker")
        .map((d) => d.pattern.replace(".стікер", ""));
      const text = names.length > 0 ? names.join("\n") : "Список порожній";
      return [{ kind: "reply_text", text, replyTo: input.messageId }];
    },
  },
  {
    name: "rate_status",
    pattern: /(К|к)ицюн(я|ю), скільки в мене лишилось\??/,
    produce: (input) => [
      {
        kind: "report_user_rate_status",
        userId: input.senderId,
        replyTo: input.messageId,
      },
    ],
  },
];
