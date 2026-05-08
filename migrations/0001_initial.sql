CREATE TABLE dynamic_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('gif', 'sticker')),
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_user_id INTEGER
);

CREATE TABLE messages (
  chat_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  sender_name TEXT,
  reply_to_id INTEGER,
  reply_to_author_id INTEGER,
  reply_to_author_name TEXT,
  text TEXT,
  kind TEXT NOT NULL,
  forward_chat_id INTEGER,
  PRIMARY KEY (chat_id, msg_id)
);

CREATE INDEX idx_messages_ts ON messages(chat_id, ts);
CREATE INDEX idx_messages_sender ON messages(chat_id, sender_id, ts);