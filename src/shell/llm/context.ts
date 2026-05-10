import type { ImageContent, UserContent } from "./anthropic.js";
import type { ProfileEntry } from "./profiles.js";

export type RecentMessage = {
  senderName: string;
  text: string;
  // Список base64-фото в логічному повідомленні (альбом → кілька, одиночне → одне).
  // Порожній — текстове повідомлення.
  photos?: ReadonlyArray<{ mime: string; base64: string }>;
};

export type CurrentMessage = {
  senderName: string;
  text: string;
  photos?: ReadonlyArray<{ mime: string; base64: string }>;
};

export type LlmRequest = {
  system: string;
  userMessage: UserContent;
};

function toImageBlock(p: { mime: string; base64: string }): ImageContent {
  // Anthropic вимагає вузький union для media_type. Дефолтимось у jpeg, якщо
  // прийшло щось екзотичне — дешевше за помилку API.
  const allowed: ImageContent["source"]["media_type"][] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];
  const media_type = (allowed as string[]).includes(p.mime)
    ? (p.mime as ImageContent["source"]["media_type"])
    : "image/jpeg";
  return {
    type: "image",
    source: { type: "base64", media_type, data: p.base64 },
  };
}

function photoMarker(count: number, startNumber: number): string {
  if (count === 0) return "";
  if (count === 1) return `[фото ${startNumber}] `;
  return `[фото ${startNumber}-${startNumber + count - 1}] `;
}

export function buildLlmRequest(
  current: CurrentMessage,
  recent: readonly RecentMessage[],
  persona: string,
  profiles: readonly ProfileEntry[] = [],
): LlmRequest {
  const sections = [persona];

  if (profiles.length > 0) {
    const profilesText = profiles.map((p) => `${p.displayName}:\n${p.profile}`).join("\n\n");
    sections.push(`Профілі учасників (для розуміння стилю і інтересів):\n\n${profilesText}`);
  }

  // Маркери [фото N] нумеруються глобально, синхронно з порядком image-blocks
  // нижче (історія в хронологічному порядку, потім поточні фото).
  let photoCounter = 1;
  const allImages: ImageContent[] = [];
  const recentLines: string[] = [];

  for (const m of recent) {
    const photos = m.photos ?? [];
    const marker = photoMarker(photos.length, photoCounter);
    photoCounter += photos.length;
    for (const p of photos) allImages.push(toImageBlock(p));
    recentLines.push(`${m.senderName}: ${marker}${m.text}`.trimEnd());
  }

  if (recentLines.length > 0) {
    sections.push(`Контекст останніх повідомлень у чаті:\n${recentLines.join("\n")}`);
  }

  const system = sections.join("\n\n");

  // Поточне повідомлення.
  const currentPhotos = current.photos ?? [];
  const currentMarker = photoMarker(currentPhotos.length, photoCounter);
  for (const p of currentPhotos) allImages.push(toImageBlock(p));
  const currentText = `${current.senderName}: ${currentMarker}${current.text}`.trimEnd();

  // Back-compat: якщо ніде немає фото — повертаємо string, як раніше.
  if (allImages.length === 0) {
    return { system, userMessage: currentText };
  }

  // Anthropic best practice: image-blocks ідуть першими, текст з посиланнями
  // на них — другим. Маркери [фото N] всередині тексту відсилають до images
  // у тому ж порядку.
  const userMessage: UserContent = [...allImages, { type: "text", text: currentText }];
  return { system, userMessage };
}
