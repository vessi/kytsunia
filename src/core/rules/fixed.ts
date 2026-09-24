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
    // «Кицюня, дайджест», «Кицюня, дай дайджест за 300», «Кицюня, дайджест 50».
    // Число опційне — без нього shell підставить дефолт із конфіга.
    name: "digest",
    pattern: /(К|к)ицюн(я|ю), (?:дай )?дайджест(?:\s+(?:за\s+)?(\d+))?/,
    produce: (input, match) => {
      const raw = match[3];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return [
        {
          kind: "invoke_digest",
          replyTo: input.messageId,
          ...(Number.isNaN(parsed) ? {} : { count: parsed }),
        },
      ];
    },
  },
  {
    // «Кицюня, пошукай курс долара». Без тексту — шукаємо за повідомленням чи
    // фото, на яке відповіли. Роздільник після «пошукай» обовʼязковий, щоб не
    // ловити «пошукайте».
    name: "web_search",
    pattern: /(К|к)ицюн(я|ю), пошукай(?:[\s,:!?.]+([\s\S]*))?$/,
    produce: (input, match) => {
      const typed = match[3]?.trim() ?? "";
      const query = typed || input.replyTo?.text?.trim() || "";
      if (!query && !input.replyTo) {
        return [{ kind: "reply_text", text: "Що шукати?", replyTo: input.messageId }];
      }
      return [{ kind: "invoke_web_search", replyTo: input.messageId, query }];
    },
  },
  {
    // «Кицюня, звіт» — за 7 днів, «Кицюня, звіт 30» — за 30. Admin only, тиха
    // ігнорація для інших, як і в say_in_chat. Роздільник після «звіт»
    // обовʼязковий, щоб не ловити «звітність».
    name: "usage_report",
    pattern: /(К|к)ицюн(я|ю), звіт(?:\s+(\d+))?(?:[!?.\s,]|$)/,
    produce: (input, match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      const raw = match[3];
      const parsed = raw ? Number.parseInt(raw, 10) : 7;
      const days = Math.min(Math.max(Number.isNaN(parsed) ? 7 : parsed, 1), 90);
      return [{ kind: "report_usage", replyTo: input.messageId, days }];
    },
  },
  {
    // «Кицюня, спеціальна інструкція <текст>» — усе після команди йде в промпт
    // моделі для цього чату як є, з переносами рядків. Без тексту — беремо
    // повідомлення, на яке відповіли. Admin only, тиха ігнорація для інших.
    name: "special_instruction_add",
    pattern: /(К|к)ицюн(я|ю), спеціальна інструкція(?:[\s,:!?.]+([\s\S]*))?$/,
    produce: (input, match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      const typed = match[3]?.trim() ?? "";
      const text = typed || input.replyTo?.text?.trim() || "";
      if (!text) {
        return [{ kind: "reply_text", text: "Яка інструкція?", replyTo: input.messageId }];
      }
      return [
        { kind: "add_special_instruction", replyTo: input.messageId, chatId: input.chatId, text },
      ];
    },
  },
  {
    // «Кицюня, спеціальні інструкції» — список цього чату з id і датами.
    name: "special_instructions_list",
    pattern: /(К|к)ицюн(я|ю), спеціальні інструкції(?:[!?.\s,]|$)/,
    produce: (input, _match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      return [
        { kind: "list_special_instructions", replyTo: input.messageId, chatId: input.chatId },
      ];
    },
  },
  {
    // «Кицюня, забудь інструкцію 3» (можна з #) — id зі списку.
    name: "special_instruction_remove",
    pattern: /(К|к)ицюн(я|ю), забудь інструкцію\s+#?(\d+)/,
    produce: (input, match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      const id = Number.parseInt(match[3] ?? "", 10);
      if (Number.isNaN(id)) return [];
      return [
        { kind: "remove_special_instruction", replyTo: input.messageId, chatId: input.chatId, id },
      ];
    },
  },
  {
    // «Кицюня, модель» — яка модель у цьому чаті; «Кицюня, модель opus» —
    // перемкнути; «Кицюня, модель скинь» — повернути дефолт. Admin only.
    // Після «модель» має бути кінець, розділовий знак або пробіл, щоб не
    // ловити «модельєр».
    name: "chat_model",
    pattern: /(К|к)ицюн(я|ю), модель(?:\s*[!?.]*$|[\s:]+(.+?)[\s!?.]*$)/,
    produce: (input, match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      const arg = match[3]?.trim() ?? "";
      const base = { replyTo: input.messageId, chatId: input.chatId };
      if (!arg) return [{ kind: "show_chat_model", ...base }];
      if (/^(скинь|скинути|дефолт|за замовчуванням)$/i.test(arg)) {
        return [{ kind: "reset_chat_model", ...base }];
      }
      return [{ kind: "set_chat_model", ...base, model: arg }];
    },
  },
  {
    // «Кицюня, персона» — показати поточну; «Кицюня, персона <текст>» або
    // «Кицюня, персона» у відповідь на повідомлення з текстом — замінити;
    // «Кицюня, персона скинь» — повернути ту, що в коді. Admin only.
    name: "chat_persona",
    pattern: /(К|к)ицюн(я|ю), персона(?:\s*[!?.]*$|[\s:,]+([\s\S]+?)\s*$)/,
    produce: (input, match, state) => {
      if (state.policy.adminUserId !== input.senderId) return [];
      const base = { replyTo: input.messageId, chatId: input.chatId };
      const typed = match[3]?.trim() ?? "";
      if (/^(скинь|скинути|дефолт|за замовчуванням)[!?.]*$/i.test(typed)) {
        return [{ kind: "reset_chat_persona", ...base }];
      }
      const text = typed || input.replyTo?.text?.trim() || "";
      if (!text) return [{ kind: "show_chat_persona", ...base }];
      return [{ kind: "set_chat_persona", ...base, text }];
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
