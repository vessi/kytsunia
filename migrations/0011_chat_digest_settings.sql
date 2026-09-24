-- Налаштування дайджесту на чат.
-- digest_max_count: стеля на кількість повідомлень. NULL — дефолт з
-- KYTSUNIA_DIGEST_MAX_COUNT. Ріже і явне число («дайджест 400»), і дефолтну
-- кількість, якщо вона вища.
-- digest_model: модель дайджесту. NULL — KYTSUNIA_DIGEST_MODEL. Не залежить
-- від моделі відповідей чату: можна opus для реплік і haiku для дайджесту.
ALTER TABLE chat_settings ADD COLUMN digest_max_count INTEGER;
ALTER TABLE chat_settings ADD COLUMN digest_model TEXT;
