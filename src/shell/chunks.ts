import type { Context } from "grammy";

// Ліміт одного повідомлення в Telegram.
export const TELEGRAM_MAX_CHARS = 4096;

// Більше — це вже не відповідь, а простирадло; хвіст обрізаємо з «…».
const MAX_CHUNKS = 5;

/**
 * Ріже довгий текст на повідомлення, що влазять у ліміт Telegram. Рве на межі
 * абзацу, інакше рядка, інакше слова, і лише в крайньому разі посеред слова,
 * не розриваючи сурогатну пару (емодзі). Дайджест і «розкажи про учасників»
 * складаються з абзаців, тож майже завжди рветься між ними.
 */
export function splitForTelegram(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // Розрив не ближче до початку, ніж половина ліміту — інакше «\n\n» на
    // третьому рядку дасть купу дрібних повідомлень.
    const floor = Math.floor(max / 2);
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < floor) cut = rest.lastIndexOf("\n", max);
    if (cut < floor) cut = rest.lastIndexOf(" ", max);
    if (cut < floor) {
      cut = max;
      const last = rest.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    if (chunks.length === MAX_CHUNKS - 1 && rest.length > max) {
      let tail = rest.slice(0, max - 1);
      const last = tail.charCodeAt(tail.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) tail = tail.slice(0, -1);
      chunks.push(`${tail}…`);
      return chunks;
    }
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Надсилає текст одним чи кількома повідомленнями. Перше — відповідь на
 * тригер, решта йдуть просто в чат, щоб не було пʼяти реплаїв на одне й те ж.
 */
export async function replyInChunks(ctx: Context, text: string, replyTo: number): Promise<void> {
  const chunks = splitForTelegram(text);
  for (const [i, chunk] of chunks.entries()) {
    await ctx.reply(chunk, i === 0 ? { reply_to_message_id: replyTo } : {});
  }
}
