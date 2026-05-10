-- Vision support: фото в messages + кеш скачаних байтів.
-- photo_unique_id стабільний у часі (Telegram гарантує) — підходить як ключ кешу.
-- media_group_id групує фото одного альбому (один рядок на фото, але всі шарять id).
ALTER TABLE messages ADD COLUMN photo_file_id TEXT;
ALTER TABLE messages ADD COLUMN photo_unique_id TEXT;
ALTER TABLE messages ADD COLUMN media_group_id TEXT;

CREATE INDEX idx_messages_media_group
  ON messages(chat_id, media_group_id)
  WHERE media_group_id IS NOT NULL;

-- Кеш завантажених байтів. Ключ — unique_id, бо file_id у Telegram може мутувати.
CREATE TABLE photo_cache (
  unique_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  fetched_ts INTEGER NOT NULL
);
