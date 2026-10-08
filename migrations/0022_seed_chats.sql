-- Засів реєстру чатів з історії: групи, де були повідомлення за останні 30
-- днів. Інакше при першому старті після деплою реєстр порожній, і оголошення
-- релізу нема куди слати. Чати, звідки бота викинули, відпадуть самі при
-- першій невдалій відправці.
INSERT OR IGNORE INTO chats (chat_id, title, joined_at, left_at)
SELECT chat_id, NULL, MIN(ts), NULL FROM messages
WHERE chat_id < 0 AND ts > (strftime('%s', 'now') * 1000 - 30 * 86400000)
GROUP BY chat_id;
