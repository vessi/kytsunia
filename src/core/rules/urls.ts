// Regex збережені 1-в-1 з оригінального бота.
// TODO: `.com` без escape означає що `instagrammcom` теж зматчиться.
// Це не критично і поза рамками FC/IS-рефакторингу. Виправимо окремо.
const INSTAGRAM_RE = /https:\/\/(www\.)?instagram\.com\/(.*)\/?/;
const X_RE = /https:\/\/(www\.)?(x|twitter)\.com\/(.*)\/?/;

export function rewriteInstagramUrl(text: string): string | null {
  const m = INSTAGRAM_RE.exec(text);
  if (!m?.[2]) return null;
  return `https://ddinstagram.com/${m[2]}`;
}

export function rewriteXUrl(text: string): string | null {
  const m = X_RE.exec(text);
  if (!m?.[3]) return null;
  return `https://fxtwitter.com/${m[3]}`;
}
