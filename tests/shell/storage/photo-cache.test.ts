import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePhotoCacheStore } from "../../../src/shell/storage/photo-cache.js";
import { openTestDb } from "../../helpers/db.js";

describe("photoCacheStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof makePhotoCacheStore>;

  beforeEach(() => {
    db = openTestDb();
    store = makePhotoCacheStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for unknown unique id", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("round-trips bytes and mime", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    store.put("uniq1", "image/png", bytes);
    const got = store.get("uniq1");
    expect(got).not.toBeNull();
    expect(got?.mime).toBe("image/png");
    expect(got?.bytes.equals(bytes)).toBe(true);
  });

  it("put twice replaces, does not duplicate", () => {
    store.put("uniq1", "image/jpeg", Buffer.from([1, 2, 3]));
    store.put("uniq1", "image/png", Buffer.from([4, 5, 6]));
    const got = store.get("uniq1");
    expect(got?.mime).toBe("image/png");
    expect(got?.bytes.equals(Buffer.from([4, 5, 6]))).toBe(true);
  });
});
