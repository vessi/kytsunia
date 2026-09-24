import { KNOWN_MODELS } from "./pricing.js";

// Короткі назви для команди «Кицюня, модель …». Без версії — поточне покоління.
const ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

/**
 * «opus» → "claude-opus-5", повний id — як є. Приймаємо лише моделі з таблиці
 * цін: інакше звіт про витрати мовчки рахував би їх у нуль.
 */
export function resolveModel(input: string): string | null {
  const key = input.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return KNOWN_MODELS.includes(id) ? id : null;
}

export function modelChoicesHelp(): string {
  return `Можна: ${Object.keys(ALIASES).join(", ")} або повний id: ${KNOWN_MODELS.join(", ")}.`;
}
