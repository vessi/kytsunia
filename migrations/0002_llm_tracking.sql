CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  trigger_msg_id INTEGER,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  status TEXT NOT NULL,
  cost_usd REAL,
  error_message TEXT
);

CREATE INDEX idx_llm_calls_user_day ON llm_calls(user_id, ts);
CREATE INDEX idx_llm_calls_global_day ON llm_calls(ts);

CREATE TABLE user_limits (
  user_id INTEGER PRIMARY KEY,
  daily_limit INTEGER,
  notes TEXT,
  updated_at INTEGER NOT NULL
);
