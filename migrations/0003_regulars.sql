CREATE TABLE regulars (
  user_id INTEGER PRIMARY KEY,
  display_name TEXT,
  profile TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  last_message_ts INTEGER,
  generated_at INTEGER NOT NULL,
  manual_notes TEXT
);

CREATE INDEX idx_regulars_generated ON regulars(generated_at);
