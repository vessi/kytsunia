import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeInstructionStore } from "../../../src/shell/storage/instructions.js";
import { openTestDb } from "../../helpers/db.js";

describe("instructionStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makeInstructionStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makeInstructionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("starts empty", () => {
    expect(store.list(1)).toEqual([]);
  });

  it("adds and lists in insertion order", () => {
    const first = store.add(1, "перша", 7);
    const second = store.add(1, "друга");
    expect(first.id).toBeLessThan(second.id);
    expect(store.list(1).map((i) => i.text)).toEqual(["перша", "друга"]);
    expect(store.list(1)[0]).toEqual(first);

    const row = db
      .prepare("SELECT created_by_user_id FROM special_instructions WHERE id = ?")
      .get(first.id) as { created_by_user_id: number | null };
    expect(row.created_by_user_id).toBe(7);
  });

  it("keeps chats apart", () => {
    store.add(1, "для першого");
    const other = store.add(2, "для другого");
    expect(store.list(1).map((i) => i.text)).toEqual(["для першого"]);
    expect(store.list(2).map((i) => i.text)).toEqual(["для другого"]);
    // Видалення по id з чужого чату — no-op.
    expect(store.remove(1, other.id)).toBe(false);
    expect(store.list(2)).toHaveLength(1);
  });

  it("removes by id and reports whether anything was removed", () => {
    const saved = store.add(1, "тимчасова");
    expect(store.remove(1, saved.id)).toBe(true);
    expect(store.remove(1, saved.id)).toBe(false);
    expect(store.list(1)).toEqual([]);
  });

  it("never reuses an id after removal", () => {
    const first = store.add(1, "перша");
    store.remove(1, first.id);
    const second = store.add(1, "друга");
    expect(second.id).toBeGreaterThan(first.id);
  });
});
