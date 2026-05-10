import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeOptOutsStore } from "../../../src/shell/storage/opt-outs.js";
import { openTestDb } from "../../helpers/db.js";

describe("optOutsStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeOptOutsStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeOptOutsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("isOptedOut returns false for unknown user", () => {
    expect(store.isOptedOut(123)).toBe(false);
  });

  it("optOut then isOptedOut returns true", () => {
    store.optOut(123);
    expect(store.isOptedOut(123)).toBe(true);
  });

  it("optOut is idempotent — second call does not throw", () => {
    store.optOut(123);
    expect(() => store.optOut(123)).not.toThrow();
    expect(store.isOptedOut(123)).toBe(true);
  });

  it("optIn returns true when user was opted out", () => {
    store.optOut(123);
    expect(store.optIn(123)).toBe(true);
    expect(store.isOptedOut(123)).toBe(false);
  });

  it("optIn returns false when user was not opted out", () => {
    expect(store.optIn(123)).toBe(false);
  });

  it("list returns all opted-out user ids", () => {
    store.optOut(1);
    store.optOut(2);
    store.optOut(3);
    expect([...store.list()].sort()).toEqual([1, 2, 3]);
  });

  it("list reflects optIn", () => {
    store.optOut(1);
    store.optOut(2);
    store.optIn(1);
    expect(store.list()).toEqual([2]);
  });

  it("optOut stores reason when provided", () => {
    store.optOut(123, "user request via chat");
    const row = db.prepare("SELECT reason FROM profile_opt_outs WHERE user_id = ?").get(123) as
      | { reason: string | null }
      | undefined;
    expect(row?.reason).toBe("user request via chat");
  });
});
