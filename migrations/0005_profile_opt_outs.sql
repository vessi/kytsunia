-- Користувачі, які явно відмовились від профайлінгу.
-- Глобально (один запис на user_id), не per-chat.
CREATE TABLE profile_opt_outs (
  user_id INTEGER PRIMARY KEY,
  opted_out_at INTEGER NOT NULL,
  reason TEXT
);
