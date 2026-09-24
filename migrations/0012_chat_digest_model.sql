-- Модель дайджесту на чат. NULL — KYTSUNIA_DIGEST_MODEL. Не залежить від
-- моделі відповідей чату: можна opus для реплік і haiku для дайджесту.
-- Окремою міграцією, бо 0011 на проді вже застосована без цієї колонки.
ALTER TABLE chat_settings ADD COLUMN digest_model TEXT;
