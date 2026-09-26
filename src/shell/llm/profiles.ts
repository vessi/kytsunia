import type { RegularProfile, RegularsStore } from "../storage/regulars.js";
import { displayWithHandle } from "./names.js";

export type ProfileEntry = {
  displayName: string;
  profile: string;
};

function toEntry(p: RegularProfile): ProfileEntry {
  const combined = p.manualNotes
    ? `${p.profile}\n\nДодаткові примітки: ${p.manualNotes}`
    : p.profile;
  return {
    displayName: displayWithHandle(p.displayName ?? "Unknown", p.username),
    profile: combined,
  };
}

/**
 * Усі профілі постійних учасників чату, від найактивнішого. Кицюня має знати
 * кожного, про кого можуть спитати, а не лише тих, хто писав щойно. Opt-out
 * тут не перевіряємо: при відмові профіль стирається, а refresh таких
 * пропускає, тож у таблиці їх немає.
 */
export function collectChatProfiles(
  store: RegularsStore,
  chatId: number,
  // Кого не показувати: самого бота, поки його старий профіль не стерто.
  excludeUserId?: number,
): ProfileEntry[] {
  return store
    .listByChat(chatId)
    .filter((p) => p.userId !== excludeUserId)
    .map(toEntry);
}

/**
 * Текст блоку профілів для system prompt. Порожній рядок — блоку не буде.
 * Стабільний між оновленнями профілів, тому кладеться в кешований префікс.
 */
export function renderProfilesBlock(profiles: readonly ProfileEntry[]): string {
  if (profiles.length === 0) return "";
  const text = profiles.map((p) => `${p.displayName}:\n${p.profile}`).join("\n\n");
  return `Профілі учасників (для розуміння стилю і інтересів):\n\n${text}`;
}
