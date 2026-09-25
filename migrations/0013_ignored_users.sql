-- Користувачі, яких Кицюня повністю ігнорує: жодних правил, гіфок, реплаїв.
-- Єдиний виняток — «Кицюня, забудь мене», щоб людина могла стерти профіль.
-- Глобально, як і opt-out: один запис на user_id.
CREATE TABLE ignored_users (
  user_id INTEGER PRIMARY KEY,
  user_name TEXT,
  ignored_at INTEGER NOT NULL,
  ignored_by_user_id INTEGER
);
