-- Стеля на кількість повідомлень у дайджесті для чату. NULL — дефолт з
-- KYTSUNIA_DIGEST_MAX_COUNT. Ріже і явне число («дайджест 400»), і дефолтну
-- кількість, якщо вона вища.
ALTER TABLE chat_settings ADD COLUMN digest_max_count INTEGER;
