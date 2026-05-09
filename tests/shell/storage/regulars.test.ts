import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRegularsStore } from "../../../src/shell/storage/regulars.js";
import { openTestDb } from "../../helpers/db.js";

describe("regularsStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeRegularsStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeRegularsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for missing user", () => {
    expect(store.get(999, 1)).toBeNull();
  });

  it("upserts and reads back a profile", () => {
    store.upsert({
      userId: 100,
      displayName: "Andriy",
      profile: "Snarky engineer.",
      messageCount: 50,
      lastMessageTs: 1000,
      chatId: 1,
    });

    const result = store.get(100, 1);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(100);
    expect(result?.displayName).toBe("Andriy");
    expect(result?.profile).toBe("Snarky engineer.");
    expect(result?.messageCount).toBe(50);
    expect(result?.generatedAt).toBeGreaterThan(0);
    expect(result?.manualNotes).toBeNull();
  });

  it("upsert overwrites profile but preserves manual_notes", () => {
    store.upsert({
      userId: 100,
      displayName: "Andriy",
      profile: "Old profile.",
      messageCount: 50,
      lastMessageTs: 1000,
      chatId: 1,
    });
    store.setManualNotes(100, 1, "Special: знає віскі");

    store.upsert({
      userId: 100,
      displayName: "Andriy",
      profile: "New profile.",
      messageCount: 60,
      lastMessageTs: 2000,
      chatId: 1,
    });

    const result = store.get(100, 1);
    expect(result?.profile).toBe("New profile.");
    expect(result?.messageCount).toBe(60);
    expect(result?.manualNotes).toBe("Special: знає віскі");
  });

  it("list returns all profiles", () => {
    store.upsert({
      userId: 1,
      displayName: "A",
      profile: "p1",
      messageCount: 1,
      lastMessageTs: 1,
      chatId: 1,
    });
    store.upsert({
      userId: 2,
      displayName: "B",
      profile: "p2",
      messageCount: 2,
      lastMessageTs: 2,
      chatId: 1,
    });

    expect(store.list()).toHaveLength(2);
  });

  it("remove returns true on existing user", () => {
    store.upsert({
      userId: 100,
      displayName: "X",
      profile: "p",
      messageCount: 1,
      lastMessageTs: 1,
      chatId: 1,
    });
    expect(store.remove(100, 1)).toBe(true);
    expect(store.get(100, 1)).toBeNull();
  });

  it("remove returns false on missing user", () => {
    expect(store.remove(999, 1)).toBe(false);
  });

  it("setManualNotes updates only notes, not profile", () => {
    store.upsert({
      userId: 100,
      displayName: "X",
      profile: "original",
      messageCount: 1,
      lastMessageTs: 1,
      chatId: 1,
    });

    store.setManualNotes(100, 1, "custom note");
    const result = store.get(100, 1);
    expect(result?.manualNotes).toBe("custom note");
    expect(result?.profile).toBe("original");
  });

  it("setManualNotes with null clears notes", () => {
    store.upsert({
      userId: 100,
      displayName: "X",
      profile: "p",
      messageCount: 1,
      lastMessageTs: 1,
      chatId: 1,
    });
    store.setManualNotes(100, 1, "something");
    store.setManualNotes(100, 1, null);

    expect(store.get(100, 1)?.manualNotes).toBeNull();
  });

  it("treats same user in different chats as separate profiles", () => {
    store.upsert({
      userId: 100,
      chatId: 1,
      displayName: "Andriy",
      profile: "В роботі скепсичний.",
      messageCount: 50,
      lastMessageTs: 1000,
    });
    store.upsert({
      userId: 100,
      chatId: 2,
      displayName: "Andriy",
      profile: "З друзями жартівливий.",
      messageCount: 50,
      lastMessageTs: 1000,
    });

    expect(store.get(100, 1)?.profile).toContain("скепсичний");
    expect(store.get(100, 2)?.profile).toContain("жартівливий");
    expect(store.list()).toHaveLength(2);
  });

  it("listByChat filters by chat", () => {
    store.upsert({
      userId: 100,
      chatId: 1,
      displayName: "A",
      profile: "p",
      messageCount: 1,
      lastMessageTs: 1,
    });
    store.upsert({
      userId: 200,
      chatId: 1,
      displayName: "B",
      profile: "p",
      messageCount: 1,
      lastMessageTs: 1,
    });
    store.upsert({
      userId: 100,
      chatId: 2,
      displayName: "A",
      profile: "p",
      messageCount: 1,
      lastMessageTs: 1,
    });

    expect(store.listByChat(1)).toHaveLength(2);
    expect(store.listByChat(2)).toHaveLength(1);
  });
});
