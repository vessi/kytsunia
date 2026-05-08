/**
 * Чисте представлення вхідного повідомлення.
 * Все, що нам потрібно знати з повідомлення для прийняття рішень,
 * без залежності від grammy.
 */
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
};

export type ReplyContext = {
  messageId: number;
  authorId: number;
  authorName: string;
  text?: string;
  animationFileId?: string;
  stickerFileId?: string;
};

export type ForwardOrigin = {
  kind: "channel";
  chatId: number;
};

export type MessageKind = "text" | "animation" | "sticker" | "photo" | "forward" | "other";

/**
 * Намір, повернений матчером. Shell інтерпретує і виконує.
 * Discriminated union на полі kind.
 */
export type Action =
  | { kind: "react"; emoji: string }
  | { kind: "reply_text"; text: string; replyTo?: number }
  | { kind: "send_animation"; chatId: number; fileId: string; replyTo?: number }
  | { kind: "send_sticker"; chatId: number; fileId: string; replyTo?: number }
  | { kind: "send_photo_url"; chatId: number; url: string; filename: string }
  | { kind: "send_message_to_chat"; chatId: number; text: string }
  | { kind: "register_dynamic_rule"; spec: DynamicRuleSpec; ackText: string; replyTo: number }
  | {
      kind: "forget_dynamic_rule";
      pattern: string;
      ackPresent: string;
      ackAbsent: string;
      replyTo: number;
    }
  | { kind: "list_dynamic_rules"; filter: "gif" | "sticker"; emptyText: string; replyTo: number }
  | { kind: "discipline_with_random_insult"; replyTo: number };

export type DynamicRuleSpec = {
  pattern: string;
  type: "gif" | "sticker";
  fileId: string;
};

export type State = {
  dynamic: DynamicRuleSpec[];
};
