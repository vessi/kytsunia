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

  it("handles the global scope", () => {
    expect(store.isIgnored(42, 1)).toBe(false);
    expect(store.addGlobal(42, "Troll", 300)).toBe(true);
    expect(store.addGlobal(42, "Troll", 300)).toBe(false);
    expect(store.isIgnored(42)).toBe(true);
    expect(store.isIgnored(42, 999)).toBe(true);
    expect(store.isGloballyIgnored(42)).toBe(true);
    expect(store.listGlobal().map((u) => [u.userId, u.userName])).toEqual([[42, "Troll"]]);
    expect(store.removeGlobal(42)).toBe(true);
    expect(store.removeGlobal(42)).toBe(false);
    expect(store.isIgnored(42)).toBe(false);
  });

  it("keeps the chat scope to its chat", () => {
    expect(store.addInChat(1, 42, "Troll", 500)).toBe(true);
    expect(store.addInChat(1, 42, "Troll", 500)).toBe(false);
    expect(store.isIgnored(42, 1)).toBe(true);
    expect(store.isIgnored(42, 2)).toBe(false);
    expect(store.isIgnored(42)).toBe(false);
    expect(store.isGloballyIgnored(42)).toBe(false);
    expect(store.listInChat(1).map((u) => u.userId)).toEqual([42]);
    expect(store.listInChat(2)).toEqual([]);
    expect(store.listGlobal()).toEqual([]);
    expect(store.removeInChat(2, 42)).toBe(false);
    expect(store.removeInChat(1, 42)).toBe(true);
    expect(store.isIgnored(42, 1)).toBe(false);
  });
});
