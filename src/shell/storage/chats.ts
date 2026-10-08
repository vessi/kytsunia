import type { Db } from "./db.js";

export type KnownChat = { chatId: number; title: string | null; announce: boolean };

export type ChatsStore = {
  // Бот у чаті (повідомлення звідти або подія «додали»).
  seen: (chatId: number, title: string | null) => void;
  left: (chatId: number) => void;
  // Групові чати, де бот зараз є.
  listActive: () => KnownChat[];
  setAnnounce: (chatId: number, on: boolean) => void;
  getAnnounce: (chatId: number) => boolean;
};

export type MetaStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
};

export function makeChatsStore(db: Db): ChatsStore {
  const seenStmt = db.prepare(
    `INSERT INTO chats (chat_id, title, joined_at, left_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(chat_id) DO UPDATE SET title = COALESCE(excluded.title, chats.title), left_at = NULL`,
  );
  const leftStmt = db.prepare("UPDATE chats SET left_at = ? WHERE chat_id = ?");
  const listStmt = db.prepare(
    // chat_id DESC — щоб порядок був визначений і при однаковому joined_at.
    "SELECT chat_id, title, announce FROM chats WHERE left_at IS NULL AND chat_id < 0 ORDER BY joined_at, chat_id DESC",
  );
  const setAnnounceStmt = db.prepare("UPDATE chats SET announce = ? WHERE chat_id = ?");
  const getAnnounceStmt = db.prepare("SELECT announce FROM chats WHERE chat_id = ?");
  return {
    seen: (chatId, title) => {
      seenStmt.run(chatId, title, Date.now());
    },
    left: (chatId) => {
      leftStmt.run(Date.now(), chatId);
    },
    listActive: () =>
      (listStmt.all() as Array<{ chat_id: number; title: string | null; announce: number }>).map(
        (r) => ({ chatId: r.chat_id, title: r.title, announce: r.announce === 1 }),
      ),
    setAnnounce: (chatId, on) => {
      setAnnounceStmt.run(on ? 1 : 0, chatId);
    },
    getAnnounce: (chatId) =>
      ((getAnnounceStmt.get(chatId) as { announce: number } | undefined)?.announce ?? 1) === 1,
  };
}

export function makeMetaStore(db: Db): MetaStore {
  const getStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setStmt = db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  return {
    get: (key) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => {
      setStmt.run(key, value, Date.now());
    },
  };
}
