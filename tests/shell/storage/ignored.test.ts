import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIgnoredUsersStore } from "../../../src/shell/storage/ignored.js";
import { openTestDb } from "../../helpers/db.js";

describe("ignoredUsersStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeIgnoredUsersStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeIgnoredUsersStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("adds once, lists and removes", () => {
    expect(store.isIgnored(42)).toBe(false);
    expect(store.add(42, "Troll", 300)).toBe(true);
    expect(store.add(42, "Troll", 300)).toBe(false);
    expect(store.isIgnored(42)).toBe(true);
    expect(store.list().map((u) => [u.userId, u.userName])).toEqual([[42, "Troll"]]);
    expect(store.remove(42)).toBe(true);
    expect(store.remove(42)).toBe(false);
    expect(store.isIgnored(42)).toBe(false);
  });
});
