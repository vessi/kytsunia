/**
 * Посилання на повідомлення в супергрупі: https://t.me/c/<id без -100>/<msg>.
 * У звичайних малих групах таких посилань немає — повертаємо null, і тоді
 * лишається лише відповідь на повідомлення, яка теж веде вгору по кліку.
 */
export function messageLink(chatId: number, messageId: number): string | null {
  const s = String(chatId);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${messageId}`;
}
