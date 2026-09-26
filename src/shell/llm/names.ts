/**
 * «Оля (@olya_k)» — так модель бачить людину скрізь: у профілях, історії,
 * гілці й поточному повідомленні. Без хендла — просто імʼя. Завдяки цьому
 * «що думаєш про @olya_k?» звʼязується з профілем Олі.
 */
export function displayWithHandle(name: string, username: string | null | undefined): string {
  const base = name || (username ? `@${username}` : "");
  if (!username || !name) return base;
  return `${name} (@${username})`;
}
