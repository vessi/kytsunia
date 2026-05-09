-- Перебудовуємо таблицю з composite primary key (user_id, chat_id).
-- Поточні дані відкидаємо (там тільки тестовий профіль).
DROP INDEX IF EXISTS idx_regulars_generated;
DROP TABLE IF EXISTS regulars;

CREATE TABLE regulars (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  display_name TEXT,
  profile TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  last_message_ts INTEGER,
  generated_at INTEGER NOT NULL,
  manual_notes TEXT,
  PRIMARY KEY (user_id, chat_id)
);

CREATE INDEX idx_regulars_chat ON regulars(chat_id);
CREATE INDEX idx_regulars_generated ON regulars(generated_at);
