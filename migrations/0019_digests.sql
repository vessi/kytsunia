-- Зроблені дайджести: вікно повідомлень, яке покрив кожен, і текст. Потрібно,
-- щоб наступний запит із вікном, що перетинається зі свіжим дайджестом, не
-- переказував те саме вдруге, а посилався на нього й добудовував лише решту.
CREATE TABLE digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  -- Повідомлення бота з дайджестом (перший шматок), для посилання.
  message_id INTEGER NOT NULL,
  from_msg_id INTEGER NOT NULL,
  to_msg_id INTEGER NOT NULL,
  count INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX idx_digests_chat_ts ON digests(chat_id, ts);
