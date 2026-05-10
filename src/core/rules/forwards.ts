import type { Action, MessageInput } from "../types.js";

// Channel ID -> response. Збережено 1-в-1 з оригіналу.
const FORWARD_RESPONSES: Record<number, { kind: "gif" | "sticker"; fileId: string }> = {
  [-1001049320233]: {
    kind: "gif",
    fileId: "CgACAgIAAxkBAAMyZhvcglG35KbZrvNN8k70TELlRfoAAuQtAAJQ3LlJOsR-fNtFEyU0BA",
  },
  [-1001360737249]: {
    kind: "sticker",
    fileId: "CAACAgIAAxkBAANPZhwqWMsNeI3blUQrTDxXWxGj-TEAAtVAAAJlqAhLXy-cMxg3dys0BA",
  },
  [-1001536630827]: {
    kind: "sticker",
    fileId: "CAACAgIAAxkBAANUZhwsDlXK63Vp3pbvT7PZfNh1QVIAApBGAAKP5ghI6Q_53Kwo-Ug0BA",
  },
};

export function matchForward(input: MessageInput): Action[] | null {
  if (input.forwardOrigin?.kind !== "channel") return null;
  const response = FORWARD_RESPONSES[input.forwardOrigin.chatId];
  if (!response) return null;

  return [
    response.kind === "gif"
      ? {
          kind: "send_animation",
          chatId: input.chatId,
          fileId: response.fileId,
          replyTo: input.messageId,
        }
      : {
          kind: "send_sticker",
          chatId: input.chatId,
          fileId: response.fileId,
          replyTo: input.messageId,
        },
  ];
}
