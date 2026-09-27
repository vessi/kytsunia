import type { Api } from "grammy";
import type { Logger } from "./logger.js";

export type ChatAdmins = {
  // Усі адміни й власник.
  admins: ReadonlySet<number>;
  // Ті, хто може обмежувати учасників (і власник): їм довіряємо ігнор.
  moderators: ReadonlySet<number>;
};

export type ChatAdminsCache = {
  get: (chatId: number) => Promise<ChatAdmins>;
};

const EMPTY: ChatAdmins = { admins: new Set(), moderators: new Set() };

/**
 * getChatAdministrators з кешем на чат. Питаємо лише коли текст схожий на
 * команду, яка цього потребує, тож кеш на десять хвилин — це один виклик на
 * чат на десять хвилин у найгіршому разі. Помилка (бот не в чаті, приват)
 * дає порожні множини: команда тоді мовчить, як для звичайного учасника.
 */
export function makeChatAdminsCache(
  api: Pick<Api, "getChatAdministrators">,
  log: Logger,
  ttlMs = 10 * 60_000,
  now: () => number = Date.now,
): ChatAdminsCache {
  const cache = new Map<number, { at: number; value: ChatAdmins }>();
  return {
    get: async (chatId) => {
      const hit = cache.get(chatId);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      try {
        const members = await api.getChatAdministrators(chatId);
        const admins = new Set<number>();
        const moderators = new Set<number>();
        for (const m of members) {
          admins.add(m.user.id);
          if (m.status === "creator" || (m.status === "administrator" && m.can_restrict_members)) {
            moderators.add(m.user.id);
          }
        }
        const value = { admins, moderators };
        cache.set(chatId, { at: now(), value });
        return value;
      } catch (err) {
        log.warn(
          { chatId, err: err instanceof Error ? err.message : err },
          "getChatAdministrators failed",
        );
        cache.set(chatId, { at: now(), value: EMPTY });
        return EMPTY;
      }
    },
  };
}
