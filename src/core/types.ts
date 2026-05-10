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
  | { kind: "invoke_llm_reply"; replyTo: number };

export type DynamicRuleSpec = {
  pattern: string;
  type: "gif" | "sticker";
  fileId: string;
};

export type Policy = {
  adminUserId?: number;
  botUserId?: number;
};

export type State = {
  dynamic: readonly DynamicRuleSpec[];
  policy: Policy;
  optedOutUserIds: ReadonlySet<number>;
};
