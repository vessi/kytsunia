import type { Action, MessageInput, State } from "../types.js";

export function matchDynamic(input: MessageInput, state: State): Action[] | null {
  for (const spec of state.dynamic) {
    if (new RegExp(spec.pattern).test(input.text)) {
      return [
        spec.type === "gif"
          ? { kind: "send_animation", chatId: input.chatId, fileId: spec.fileId }
          : { kind: "send_sticker", chatId: input.chatId, fileId: spec.fileId },
      ];
    }
  }
  return null;
}
