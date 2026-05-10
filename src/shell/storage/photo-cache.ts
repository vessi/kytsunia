import type { Db } from "./db.js";

export type CachedPhoto = {
  mime: string;
  bytes: Buffer;
};

export type PhotoCacheStore = {
  get: (uniqueId: string) => CachedPhoto | null;
  put: (uniqueId: string, mime: string, bytes: Buffer) => void;
};

interface Row {
  mime: string;
  bytes: Buffer;
}

/**
 * Кеш скачаних фото з Telegram. Ключ — file_unique_id, бо Telegram гарантує
 * стабільність цього id для одного й того ж фото (на відміну від file_id, який
 * може мутувати). TTL не потрібен, фото незмінне.
 */
export function makePhotoCacheStore(db: Db): PhotoCacheStore {
  const getStmt = db.prepare("SELECT mime, bytes FROM photo_cache WHERE unique_id = ?");
  const putStmt = db.prepare(
    "INSERT OR REPLACE INTO photo_cache (unique_id, mime, bytes, fetched_ts) VALUES (?, ?, ?, ?)",
  );

  return {
    get: (uniqueId) => {
      const row = getStmt.get(uniqueId) as Row | undefined;
      if (!row) return null;
      // better-sqlite3 повертає BLOB як Buffer.
      return { mime: row.mime, bytes: row.bytes };
    },
    put: (uniqueId, mime, bytes) => {
      putStmt.run(uniqueId, mime, bytes, Date.now());
    },
  };
}
