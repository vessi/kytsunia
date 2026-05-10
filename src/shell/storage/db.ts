import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "../logger.js";

export type Db = Database.Database;

interface MigrationRow {
  id: number;
}

export function openDb(path: string, log: Logger): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, "migrations", log);
  return db;
}

function migrate(db: Db, dir: string, log: Logger): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const rows = db.prepare("SELECT id FROM _migrations").all() as MigrationRow[];
  const applied = new Set(rows.map((r) => r.id));

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const idStr = f.split("_")[0];
    if (!idStr) {
      log.warn({ file: f }, "skipping migration with invalid name");
      continue;
    }
    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      log.warn({ file: f }, "skipping migration with non-numeric id");
      continue;
    }
    if (applied.has(id)) continue;

    const sql = readFileSync(join(dir, f), "utf-8");
    log.info({ id, file: f }, "applying migration");

    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").run(id, Date.now());
    });
    tx();
  }
}
