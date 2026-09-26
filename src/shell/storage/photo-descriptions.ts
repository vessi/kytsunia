import type { Db } from "./db.js";

export type PhotoDescriptionStore = {
  get: (uniqueId: string) => string | null;
  put: (uniqueId: string, description: string, model: string) => void;
};

export function makePhotoDescriptionStore(db: Db): PhotoDescriptionStore {
  const getStmt = db.prepare(
    "SELECT description FROM photo_descriptions WHERE photo_unique_id = ?",
  );
  const putStmt = db.prepare(
    `INSERT OR REPLACE INTO photo_descriptions (photo_unique_id, description, model, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  return {
    get: (uniqueId) =>
      (getStmt.get(uniqueId) as { description: string } | undefined)?.description ?? null,
    put: (uniqueId, description, model) => {
      putStmt.run(uniqueId, description, model, Date.now());
    },
  };
}
