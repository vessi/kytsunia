import type { Context } from "grammy";

// Telegram гасить «друкує…» приблизно через 5 с або коли бот надсилає
// повідомлення. Для довгих викликів (пошук, дайджест) статус треба поновлювати.
const REFRESH_MS = 4000;

export type TypingStarter = (ctx: Context) => () => void;

/**
 * Вмикає «друкує…» і поновлює його, доки не викличуть повернуту функцію.
 * Помилки ковтаємо: індикатор — косметика, і валити через нього відповідь
 * не варто (наприклад, якщо бота обмежили в правах у групі).
 */
export function startTyping(ctx: Context, refreshMs: number = REFRESH_MS): () => void {
  const send = () => {
    try {
      ctx.replyWithChatAction("typing").catch(() => undefined);
    } catch {
      // grammY кидає синхронно, якщо в апдейті немає chat — ігноруємо так само.
    }
  };
  send();
  const timer = setInterval(send, refreshMs);
  return () => clearInterval(timer);
}
