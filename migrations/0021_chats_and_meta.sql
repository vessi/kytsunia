-- Реєстр чатів, де бот є. Оновлюється з подій my_chat_member (додали /
-- видалили) і з кожного групового повідомлення. Потрібен для оголошень і
-- «опиши всі чати»: історія повідомлень містить і чати, звідки бота давно
-- викинули. announce = 0 — цей чат оголошень не отримує.
CREATE TABLE chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  announce INTEGER NOT NULL DEFAULT 1
);

-- Дрібні факти про сам процес: остання оголошена версія тощо.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
