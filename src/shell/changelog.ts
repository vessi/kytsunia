import { readFileSync } from "node:fs";

/**
 * CHANGELOG.md: секції «## <версія>», під ними рядки-пункти. Повертає текст
 * пунктів для заданої версії або null, якщо такої секції нема. Рядки з
 * порожнім вмістом і підзаголовки ігноруються.
 */
export function changelogFor(markdown: string, version: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (l) =>
      /^##\s+/.test(l) &&
      l
        .replace(/^##\s+/, "")
        .trim()
        .split(/\s/)[0] === version,
  );
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const t = line.trim();
    if (t && !t.startsWith("#")) body.push(t.replace(/^[-*]\s+/, "- "));
  }
  return body.length > 0 ? body.join("\n") : null;
}

export function readChangelog(path = "CHANGELOG.md"): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
