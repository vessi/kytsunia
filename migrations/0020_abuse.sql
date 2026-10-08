-- Абʼюз щодо бота (AUP від 2026-11-12: «sustained and needless abusive or
-- cruel behavior toward our models»). Кожен удар — окремий рядок із причиною
-- від класифікатора, щоб адмін міг переглянути. Лічильник вічний, глобальний.
CREATE TABLE abuse_strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX idx_abuse_strikes_user ON abuse_strikes(user_id, ts);

-- Активний бан: until NULL — назавжди. Знімає лише адмін бота («пробач»).
CREATE TABLE abuse_bans (
  user_id INTEGER PRIMARY KEY,
  user_name TEXT,
  since INTEGER NOT NULL,
  until INTEGER,
  strikes INTEGER NOT NULL
);
