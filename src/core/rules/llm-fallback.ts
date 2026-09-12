import type { Action, MessageInput, State } from "../types.js";

const ADDRESSED = /(К|к)ицюн[яюіе]/;

// Telegram-username: латиниця/цифри/підкреслення. Перед `@` допускаємо тільки
// початок рядка або не-словесний символ — щоб не ловити email-подібні рядки
// (`user@kytsynia_bot`) як mention.
function isMentioned(text: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\W)@${escaped}(?!\\w)`, "i").test(text);
}

export function matchLlmFallback(input: MessageInput, state: State): Action[] | null {
  // Особисті повідомлення: у Telegram chat.id приватного чату дорівнює
  // user.id співрозмовника. Там звертатися до Кицюні по імені не треба.
  const isPrivate = input.chatId === input.senderId;

  const isAddressed = ADDRESSED.test(input.text);

  const isMention =
    state.policy.botUsername !== undefined && isMentioned(input.text, state.policy.botUsername);

  const isReplyToBot =
    state.policy.botUserId !== undefined && input.replyTo?.authorId === state.policy.botUserId;

  if (!isPrivate && !isAddressed && !isMention && !isReplyToBot) return null;
  return [{ kind: "invoke_llm_reply", replyTo: input.messageId }];
}
