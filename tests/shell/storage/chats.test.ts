import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeChatsStore, makeMetaStore } from "../../../src/shell/storage/chats.js";
import { openTestDb } from "../../helpers/db.js";

describe("chats and meta stores", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("tracks where the bot is, keeps titles, and the announce flag", () => {
    const chats = makeChatsStore(db);
    chats.seen(-1, "Віскі");
    chats.seen(-2, null);
    chats.seen(42, "приват");
    expect(chats.listActive().map((c) => [c.chatId, c.title, c.announce])).toEqual([
      [-1, "Віскі", true],
      [-2, null, true],
    ]);
    chats.seen(-1, null); // назву не затираємо порожньою
    expect(chats.listActive()[0]?.title).toBe("Віскі");

    chats.setAnnounce(-1, false);
    expect(chats.getAnnounce(-1)).toBe(false);
    expect(chats.getAnnounce(-999)).toBe(true);

    chats.left(-2);
    expect(chats.listActive().map((c) => c.chatId)).toEqual([-1]);
    chats.seen(-2, "Знову");
    expect(chats.listActive().map((c) => c.chatId)).toEqual([-1, -2]);
  });

  it("stores meta values", () => {
    const meta = makeMetaStore(db);
    expect(meta.get("announced_version")).toBeNull();
    meta.set("announced_version", "0.2.0");
    meta.set("announced_version", "0.3.0");
    expect(meta.get("announced_version")).toBe("0.3.0");
  });
});
