import type { ProfileEntry } from "./profiles.js";

export type RecentMessage = {
  senderName: string;
  text: string;
};

export type CurrentMessage = {
  senderName: string;
  text: string;
};

export type LlmRequest = {
  system: string;
  userMessage: string;
};

export function buildLlmRequest(
  current: CurrentMessage,
  recent: readonly RecentMessage[],
  persona: string,
  profiles: readonly ProfileEntry[] = [],
): LlmRequest {
  const sections = [persona];

  if (profiles.length > 0) {
    const profilesText = profiles.map((p) => `${p.displayName}:\n${p.profile}`).join("\n\n");
    sections.push(`Профілі учасників (для розуміння стилю і інтересів):\n\n${profilesText}`);
  }

  if (recent.length > 0) {
    const contextLines = recent.map((m) => `${m.senderName}: ${m.text}`).join("\n");
    sections.push(`Контекст останніх повідомлень у чаті:\n${contextLines}`);
  }

  const system = sections.join("\n\n");
  const userMessage = `${current.senderName}: ${current.text}`;

  return { system, userMessage };
}
