-- Ігнор у скоупі чату: адмін чату з правом обмежувати учасників може вимкнути
-- людину лише у своєму чаті. Глобальний ігнор від адміна бота лишається в
-- ignored_users. Матчер перевіряє обидва.
CREATE TABLE chat_ignored_users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  ignored_at INTEGER NOT NULL,
  ignored_by_user_id INTEGER,
  PRIMARY KEY (chat_id, user_id)
);
