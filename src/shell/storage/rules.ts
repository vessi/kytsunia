import type { DynamicRuleSpec } from "../../core/types.js";
import type { Logger } from "../logger.js";
import type { Db } from "./db.js";

interface RuleRow {
  pattern: string;
  type: "gif" | "sticker";
  file_id: string;
}

export type DynamicRuleStore = {
  list: () => readonly DynamicRuleSpec[];
  add: (spec: DynamicRuleSpec, createdByUserId?: number | null) => void;
  remove: (pattern: string) => boolean;
};

export function makeDynamicRuleStore(db: Db, log: Logger): DynamicRuleStore {
  const initialRows = db
    .prepare("SELECT pattern, type, file_id FROM dynamic_rules")
    .all() as RuleRow[];

  const cache: DynamicRuleSpec[] = initialRows.map((r) => ({
    pattern: r.pattern,
    type: r.type,
    fileId: r.file_id,
  }));

  log.info({ count: cache.length }, "dynamic rules loaded");

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO dynamic_rules (pattern, type, file_id, created_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare("DELETE FROM dynamic_rules WHERE pattern = ?");

  return {
    list: () => cache,

    add: (spec, createdByUserId = null) => {
      const result = insertStmt.run(
        spec.pattern,
        spec.type,
        spec.fileId,
        Date.now(),
        createdByUserId,
      );
      if (result.changes > 0) {
        cache.push(spec);
      }
    },

    remove: (pattern) => {
      const result = deleteStmt.run(pattern);
      if (result.changes === 0) return false;
      const idx = cache.findIndex((d) => d.pattern === pattern);
      if (idx >= 0) cache.splice(idx, 1);
      return true;
    },
  };
}
