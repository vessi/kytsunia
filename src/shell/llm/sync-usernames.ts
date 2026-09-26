import type { Api } from "grammy";
import type { Logger } from "../logger.js";
import type { UsersStore } from "../storage/users.js";

export type SyncUsernamesDeps = {
  api: Pick<Api, "getChatMember">;
  usersStore: UsersStore;
  log: Logger;
};

/**
 * Хендли тих, хто не писав після деплою: Telegram не віддає історію, зате
 * getChatMember віддає username учасника за user_id. Кличемо для постійних
 * чату після оновлення профілів. Помилка на одному (вийшов з чату,
 * заблокував бота) не зупиняє решту.
 */
export async function syncUsernames(
  deps: SyncUsernamesDeps,
  chatId: number,
  userIds: readonly number[],
): Promise<{ synced: number; withHandle: number }> {
  let synced = 0;
  let withHandle = 0;
  for (const userId of userIds) {
    try {
      const member = await deps.api.getChatMember(chatId, userId);
      const username = member.user.username ?? null;
      deps.usersStore.upsert({ userId, username, firstName: member.user.first_name || null });
      synced += 1;
      if (username) withHandle += 1;
    } catch (err) {
      deps.log.warn(
        { chatId, userId, err: err instanceof Error ? err.message : err },
        "getChatMember failed",
      );
    }
  }
  deps.log.info({ chatId, synced, withHandle, of: userIds.length }, "usernames synced");
  return { synced, withHandle };
}
