import type { ImageContent, SystemBlock, UserContent } from "./anthropic.js";
import type { ProfileEntry } from "./profiles.js";
import type { ThreadMessage } from "./thread.js";

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
  // Масив, бо persona йде окремим блоком з cache_control: ephemeral, а
  // profiles+recent (мінливий хвіст) — окремим без кешу. Anthropic кешує
  // префікс до останнього блоку з cache_control включно.
  system: SystemBlock[];
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
  thread: readonly ThreadMessage[] = [],
): LlmRequest {
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

  // System розколотий на два блоки:
  //   [0] persona — стабільний префікс, кешуємо.
  //   [1] profiles + recent — мінливий хвіст, без кешу.
  // Якщо хвіст порожній — другий блок не додаємо, щоб не платити за порожній text.
  const tailSections: string[] = [];
  if (profiles.length > 0) {
    const profilesText = profiles.map((p) => `${p.displayName}:\n${p.profile}`).join("\n\n");
    tailSections.push(`Профілі учасників (для розуміння стилю і інтересів):\n\n${profilesText}`);
  }
  if (recentLines.length > 0) {
    tailSections.push(`Контекст останніх повідомлень у чаті:\n${recentLines.join("\n")}`);
  }
  // Гілка йде останньою — найближче до самого питання. Повідомлення з неї
  // можуть дублювати recent: це нормально, цінність саме в позначці «на що
  // відповідають».
  if (thread.length > 0) {
    const threadLines = thread.map((m) => `${m.senderName}: ${m.text}`);
    tailSections.push(
      `Гілка, на яку відповідає користувач, від старішого до новішого. Останній рядок — саме те повідомлення, на яке він відповідає:\n${threadLines.join("\n")}`,
    );
  }

  const system: SystemBlock[] = [
    { type: "text", text: persona, cache_control: { type: "ephemeral" } },
  ];
  if (tailSections.length > 0) {
    system.push({ type: "text", text: tailSections.join("\n\n") });
  }

  // Поточне повідомлення.
  const currentPhotos = current.photos ?? [];
  const currentMarker = photoMarker(currentPhotos.length, photoCounter);
  for (const p of currentPhotos) allImages.push(toImageBlock(p));
  const currentText = `${current.senderName}: ${currentMarker}${current.text}`.trimEnd();

  // Back-compat: якщо ніде немає фото — userMessage як string, як раніше.
  if (allImages.length === 0) {
    return { system, userMessage: currentText };
  }

  // Anthropic best practice: image-blocks ідуть першими, текст з посиланнями
  // на них — другим. Маркери [фото N] всередині тексту відсилають до images
  // у тому ж порядку.
  const userMessage: UserContent = [...allImages, { type: "text", text: currentText }];
  return { system, userMessage };
}
