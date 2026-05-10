/**
 * Початок календарного дня за київським часом, як unix timestamp у мс.
 * Враховує DST автоматично через Intl.DateTimeFormat.
 */
export function startOfKyivDay(now: Date = new Date()): number {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";

  const hour = Number.parseInt(get("hour"), 10);
  const minute = Number.parseInt(get("minute"), 10);
  const second = Number.parseInt(get("second"), 10);

  const elapsedMs = (hour * 3600 + minute * 60 + second) * 1000;
  return now.getTime() - elapsedMs;
}
