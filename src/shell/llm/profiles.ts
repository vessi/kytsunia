import type { RecentMessageRow } from "../storage/messages.js";
import type { RegularProfile, RegularsStore } from "../storage/regulars.js";

export type ProfileEntry = {
  displayName: string;
  profile: string;
};

function toEntry(p: RegularProfile): ProfileEntry {
  const combined = p.manualNotes
    ? `${p.profile}\n\nДодаткові примітки: ${p.manualNotes}`
    : p.profile;
  return {
    displayName: p.displayName ?? "Unknown",
    profile: combined,
  };
}

export function collectProfiles(
  store: RegularsStore,
  senderId: number,
  chatId: number,
  recent: readonly RecentMessageRow[],
  limit: number,
): ProfileEntry[] {
  const seen = new Set<number>();
  const result: ProfileEntry[] = [];

  const senderProfile = store.get(senderId, chatId);
  if (senderProfile) {
    result.push(toEntry(senderProfile));
    seen.add(senderId);
  }

  const counts = new Map<number, number>();
  for (const msg of recent) {
    counts.set(msg.senderId, (counts.get(msg.senderId) ?? 0) + 1);
  }

  const sortedIds = [...counts.entries()]
    .filter(([id]) => !seen.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  for (const id of sortedIds) {
    if (result.length >= limit) break;
    const profile = store.get(id, chatId);
    if (profile) {
      result.push(toEntry(profile));
      seen.add(id);
    }
  }

  return result;
}
