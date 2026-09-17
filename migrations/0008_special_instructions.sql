-- Спеціальні інструкції від адміна: довільний текст, який дописується до
-- промпту моделі (відповіді й дайджест) у конкретному чаті. AUTOINCREMENT —
-- щоб id зі старого списку ніколи не вказав на іншу, новішу інструкцію.
CREATE TABLE special_instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_user_id INTEGER
);

CREATE INDEX idx_special_instructions_chat ON special_instructions(chat_id, id);
