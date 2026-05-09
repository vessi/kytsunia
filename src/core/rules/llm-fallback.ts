import type { Action, MessageInput, State } from "../types.js";

const ADDRESSED = /(К|к)ицюн[яюіе]/;

export function matchLlmFallback(input: MessageInput, state: State): Action[] | null {
  const isAddressed = ADDRESSED.test(input.text);

  const isReplyToBot =
    state.policy.botUserId !== undefined && input.replyTo?.authorId === state.policy.botUserId;

  if (!isAddressed && !isReplyToBot) return null;
  return [{ kind: "invoke_llm_reply", replyTo: input.messageId }];
}
