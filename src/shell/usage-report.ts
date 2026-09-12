import type { UsageSummary } from "./storage/llm-calls.js";
import { formatKyivDate } from "./time.js";

export type UsageReportInput = {
  days: number;
  sinceTs: number;
  period: UsageSummary;
  today: UsageSummary;
  // Чат, у якому попросили звіт: у списку чатів позначається як «цей чат».
  currentChatId: number;
};

function usd(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 3)}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function calls(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} виклик`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} виклики`;
  return `${n} викликів`;
}

function dayWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "дні";
  return "днів";
}

/**
 * Текст адмінського звіту. Без markdown — як і решта відповідей бота.
 * Частка кешу рахується від усіх вхідних токенів: input + cache read + cache write.
 */
export function formatUsageReport(r: UsageReportInput): string {
  const p = r.period;
  const lines: string[] = [];

  lines.push(`Звіт за ${r.days} ${dayWord(r.days)}, з ${formatKyivDate(r.sinceTs)}`);
  if (p.ok.calls === 0 && p.errors === 0 && p.rateLimited === 0) {
    lines.push("Викликів не було.");
    return lines.join("\n");
  }

  lines.push(`Викликів: ${p.ok.calls}, разом ${usd(p.ok.costUsd)}`);
  const allInput = p.ok.inputTokens + p.ok.cacheReadTokens + p.ok.cacheWriteTokens;
  if (allInput > 0) {
    const share = Math.round((100 * p.ok.cacheReadTokens) / allInput);
    lines.push(
      `Токени: ${tokens(allInput)} вхідних, з них ${share}% з кешу; ${tokens(p.ok.outputTokens)} вихідних`,
    );
  }
  if (p.errors > 0 || p.rateLimited > 0) {
    lines.push(`Помилок: ${p.errors}, відмов по ліміту: ${p.rateLimited}`);
  }

  if (p.byModel.length > 1) {
    lines.push("", "По моделях:");
    for (const m of p.byModel) lines.push(`${m.model}: ${calls(m.calls)}, ${usd(m.costUsd)}`);
  }

  if (p.byChat.length > 0) {
    lines.push("", "По чатах:");
    for (const c of p.byChat) {
      const name = c.chatId === r.currentChatId ? "цей чат" : String(c.chatId);
      lines.push(`${name}: ${calls(c.calls)}, ${usd(c.costUsd)}`);
    }
  }

  if (p.byUser.length > 0) {
    lines.push("", "По людях:");
    for (const u of p.byUser) {
      lines.push(`${u.userName || u.userId}: ${calls(u.calls)}, ${usd(u.costUsd)}`);
    }
  }

  lines.push("", `Сьогодні: ${calls(r.today.ok.calls)}, ${usd(r.today.ok.costUsd)}`);
  return lines.join("\n");
}
