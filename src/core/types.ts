export type MessageInput = {
  text: string;
  messageId: number;
  chatId: number;
  senderId: number;
  senderName: string;
  // Telegram @username без @, якщо є.
  senderUsername?: string;
  ts: number;
  replyTo?: ReplyContext;
  forwardOrigin?: ForwardOrigin;
  kind: MessageKind;
  // Найбільший розмір з m.photo. Caption йде в text вище.
  photoFileId?: string;
  photoUniqueId?: string;
  // Альбом: всі фото-update-и з одним media_group_id належать одному повідомленню юзера.
  mediaGroupId?: string;
};

export type ReplyContext = {
  messageId: number;
  authorId: number;
  authorName: string;
  authorUsername?: string;
  text?: string;
  animationFileId?: string;
  stickerFileId?: string;
  photoFileId?: string;
  photoUniqueId?: string;
  mediaGroupId?: string;
};

export type ForwardOrigin = {
  kind: "channel";
  chatId: number;
};

export type MessageKind = "text" | "animation" | "sticker" | "photo" | "forward" | "other";

export type Action =
  | { kind: "react"; emoji: string }
  | { kind: "reply_text"; text: string; replyTo?: number }
  | { kind: "send_animation"; chatId: number; fileId: string; replyTo?: number }
  | { kind: "send_sticker"; chatId: number; fileId: string; replyTo?: number }
  | { kind: "send_photo_url"; chatId: number; url: string; filename: string }
  | { kind: "send_message_to_chat"; chatId: number; text: string }
  | { kind: "register_dynamic_rule"; spec: DynamicRuleSpec }
  | { kind: "forget_dynamic_rule"; pattern: string }
  | { kind: "discipline_with_random_insult"; replyTo: number }
  | { kind: "report_user_rate_status"; userId: number; replyTo: number }
  | { kind: "opt_out_profile"; userId: number; replyTo: number }
  | { kind: "opt_in_profile"; userId: number; replyTo: number }
  | { kind: "report_opt_out_status"; userId: number; replyTo: number }
  | { kind: "invoke_llm_reply"; replyTo: number }
  // count відсутній — беремо дефолт із конфіга. Клампимо до максимуму вже в
  // shell, щоб core лишався без знання про env.
  | { kind: "invoke_digest"; replyTo: number; count?: number }
  // Явний пошук. query порожній, коли шукати треба за повідомленням чи фото, на яке відповіли.
  | { kind: "invoke_web_search"; replyTo: number; query: string }
  // Адмінський звіт про витрати на модель за останні days днів (включно з сьогодні).
  | { kind: "report_usage"; replyTo: number; days: number }
  // Адмінські спеціальні інструкції — довільний текст, який дописується до
  // промпту моделі в цьому чаті.
  | { kind: "add_special_instruction"; replyTo: number; chatId: number; text: string }
  | { kind: "list_special_instructions"; replyTo: number; chatId: number }
  | { kind: "remove_special_instruction"; replyTo: number; chatId: number; id: number }
  // Адмінський вибір моделі для чату. model — як написав адмін («opus» чи повний
  // id): розбирає й перевіряє shell, бо список моделей живе там.
  | { kind: "show_chat_model"; replyTo: number; chatId: number }
  | { kind: "set_chat_model"; replyTo: number; chatId: number; model: string }
  | { kind: "reset_chat_model"; replyTo: number; chatId: number }
  // Те саме для моделі дайджесту, окремо від моделі відповідей.
  | { kind: "show_digest_model"; replyTo: number; chatId: number }
  | { kind: "set_digest_model"; replyTo: number; chatId: number; model: string }
  | { kind: "reset_digest_model"; replyTo: number; chatId: number }
  // Адмінська персона для чату: текст характеру замість зашитого в коді.
  | { kind: "show_chat_persona"; replyTo: number; chatId: number }
  | { kind: "set_chat_persona"; replyTo: number; chatId: number; text: string }
  | { kind: "reset_chat_persona"; replyTo: number; chatId: number }
  // Адмінська стеля на кількість повідомлень у дайджесті для чату.
  | { kind: "show_digest_max"; replyTo: number; chatId: number }
  | { kind: "set_digest_max"; replyTo: number; chatId: number; max: number }
  | { kind: "reset_digest_max"; replyTo: number; chatId: number }
  // «Розкажи про учасників»: короткий портрет кожного постійного з профілів у базі.
  | { kind: "invoke_roster"; replyTo: number }
  // Адмінський чорний список: userId з повідомлення, на яке відповіли.
  | { kind: "ignore_user"; replyTo: number; userId: number; userName: string }
  | { kind: "unignore_user"; replyTo: number; userId: number; userName: string }
  | { kind: "list_ignored"; replyTo: number }
  // Адмінське оновлення профілів постійних учасників цього чату.
  | { kind: "refresh_profiles"; replyTo: number; chatId: number };

export type DynamicRuleSpec = {
  pattern: string;
  type: "gif" | "sticker";
  fileId: string;
};

export type Policy = {
  adminUserId?: number;
  botUserId?: number;
  // Telegram-username бота без @, наприклад "kytsynia_bot". Заповнюється з
  // bot.botInfo.username при старті. Якщо undefined — тригер по @mention
  // вимкнено (наприклад у тестах без живого Telegram).
  botUsername?: string;
};

export type State = {
  dynamic: readonly DynamicRuleSpec[];
  policy: Policy;
  optedOutUserIds: ReadonlySet<number>;
  // Кого Кицюня ігнорує повністю. Для них працює лише «забудь мене».
  ignoredUserIds: ReadonlySet<number>;
};
