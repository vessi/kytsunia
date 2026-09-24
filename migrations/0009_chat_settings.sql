-- Налаштування на рівні чату. Поки що лише модель: NULL або відсутній рядок
-- означає «модель за замовчуванням з LLM_MODEL».
CREATE TABLE chat_settings (
  chat_id INTEGER PRIMARY KEY,
  model TEXT,
  updated_at INTEGER NOT NULL,
  updated_by_user_id INTEGER
);
