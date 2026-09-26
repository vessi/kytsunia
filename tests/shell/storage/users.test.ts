import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRegularsStore } from "../../../src/shell/storage/regulars.js";
import { makeUsersStore } from "../../../src/shell/storage/users.js";
import { openTestDb } from "../../helpers/db.js";

describe("usersStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("upserts and reports the latest username", () => {
    const store = makeUsersStore(db);
    expect(store.usernameOf(8)).toBeNull();
    store.upsert({ userId: 8, username: "olya", firstName: "Оля" });
    expect(store.usernameOf(8)).toBe("olya");
    store.upsert({ userId: 8, username: "olya_k", firstName: "Оля" });
    expect(store.usernameOf(8)).toBe("olya_k");
    store.upsert({ userId: 8, username: null, firstName: "Оля" });
    expect(store.usernameOf(8)).toBeNull();
  });

  it("is joined into regulars profiles", () => {
    const users = makeUsersStore(db);
    const regulars = makeRegularsStore(db);
    regulars.upsert({
      userId: 8,
      chatId: 1,
      displayName: "Оля",
      profile: "Бігає.",
      messageCount: 40,
      lastMessageTs: 0,
    });
    expect(regulars.get(8, 1)?.username).toBeNull();
    users.upsert({ userId: 8, username: "olya_k", firstName: "Оля" });
    expect(regulars.get(8, 1)?.username).toBe("olya_k");
    expect(regulars.listByChat(1)[0]?.username).toBe("olya_k");
  });
});
