import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export function openTestDb(): Database.Database {
  const db = new Database(":memory:");
  const files = readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(join("migrations", f), "utf-8"));
  }
  return db;
}
