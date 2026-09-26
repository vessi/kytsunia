import type Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncUsernames } from "../../../src/shell/llm/sync-usernames.js";
import { makeUsersStore } from "../../../src/shell/storage/users.js";
import { openTestDb } from "../../helpers/db.js";

describe("syncUsernames", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("stores handles from getChatMember and survives failures", async () => {
    const usersStore = makeUsersStore(db);
    const getChatMember = vi.fn(async (_chatId: number, userId: number) => {
      if (userId === 9) throw new Error("user not found");
      return {
        user: {
          id: userId,
          first_name: userId === 8 ? "Оля" : "Іван",
          username: userId === 8 ? "olya_k" : undefined,
        },
      };
    });
    const result = await syncUsernames(
      { api: { getChatMember } as never, usersStore, log: pino({ level: "silent" }) },
      1,
      [8, 9, 10],
    );
    expect(result).toEqual({ synced: 2, withHandle: 1 });
    expect(usersStore.usernameOf(8)).toBe("olya_k");
    expect(usersStore.usernameOf(10)).toBeNull();
    expect(getChatMember).toHaveBeenCalledTimes(3);
  });
});
