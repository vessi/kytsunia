export type MessageInput = {
  text: string;
  messageId: number;
  chatId: number;
  senderId: number;
  senderName: string;
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
  | { kind: "invoke_digest"; replyTo: number; count?: number };

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
};
