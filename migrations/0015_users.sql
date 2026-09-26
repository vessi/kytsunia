-- Хто є хто: user_id → @username і імʼя. Оновлюється з кожного повідомлення
-- (і з автора повідомлення, на яке відповіли), бо люди перейменовуються.
-- Потрібно, щоб модель звʼязувала «@olya_k» у тексті з «Оля» у профілі.
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  updated_at INTEGER NOT NULL
);
