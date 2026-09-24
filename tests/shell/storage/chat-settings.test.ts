import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeChatSettingsStore } from "../../../src/shell/storage/chat-settings.js";
import { openTestDb } from "../../helpers/db.js";

describe("chatSettingsStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeChatSettingsStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeChatSettingsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("has no override by default", () => {
    expect(store.getModel(1)).toBeNull();
  });

  it("sets, overwrites and scopes the model per chat", () => {
    store.setModel(1, "claude-opus-5", 7);
    store.setModel(2, "claude-haiku-4-5");
    expect(store.getModel(1)).toBe("claude-opus-5");
    expect(store.getModel(2)).toBe("claude-haiku-4-5");

    store.setModel(1, "claude-sonnet-5");
    expect(store.getModel(1)).toBe("claude-sonnet-5");
    expect(store.getModel(2)).toBe("claude-haiku-4-5");
  });

  it("keeps persona and model independent", () => {
    store.setModel(1, "claude-opus-5");
    store.setPersona(1, "Ти сумна сова.", 7);
    expect(store.getPersona(1)).toBe("Ти сумна сова.");
    expect(store.getModel(1)).toBe("claude-opus-5");

    expect(store.clearModel(1)).toBe(true);
    expect(store.getPersona(1)).toBe("Ти сумна сова.");
    expect(store.clearPersona(1)).toBe(true);
    expect(store.clearPersona(1)).toBe(false);
    expect(store.getPersona(1)).toBeNull();
    expect(store.getPersona(2)).toBeNull();
  });

  it("clears and reports whether there was an override", () => {
    store.setModel(1, "claude-opus-5");
    expect(store.clearModel(1)).toBe(true);
    expect(store.clearModel(1)).toBe(false);
    expect(store.getModel(1)).toBeNull();
  });
});
