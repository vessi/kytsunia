-- Короткі текстові описи фото для контексту останніх повідомлень. Ключ —
-- photo_unique_id (стабільний у Telegram). Генеруються ліниво, коли фото
-- вперше потрапляє у вікно контексту звернення до Кицюні, і живуть назавжди:
-- фото незмінне, а описувати вдруге — платити вдруге.
CREATE TABLE photo_descriptions (
  photo_unique_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
