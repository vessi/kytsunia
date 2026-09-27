import { formatKyivNow } from "../time.js";
import type { CacheTtl, ImageContent, SystemBlock, UserContent } from "./anthropic.js";
import { renderInstructionsBlock } from "./persona.js";
import { type ProfileEntry, renderProfilesBlock } from "./profiles.js";
import type { ThreadMessage } from "./thread.js";

export type RecentMessage = {
  senderName: string;
  text: string;
  // Список base64-фото в логічному повідомленні (альбом → кілька, одиночне → одне).
  // Порожній — текстове повідомлення. Для історії не використовується: живе
  // зображення перетягує увагу моделі на себе на всі наступні відповіді.
  photos?: ReadonlyArray<{ mime: string; base64: string }>;
  // Текстові описи фото цього повідомлення — те, що модель бачить замість картинки.
  photoNotes?: readonly string[];
  // Скільки фото було, якщо описів нема (ліміт описів чи помилка) — щоб лишити «[фото]».
  photoCount?: number;
};

export type CurrentMessage = {
  senderName: string;
  text: string;
  photos?: ReadonlyArray<{ mime: string; base64: string }>;
};

export type RequestOptions = {
  // Спеціальні інструкції адміна: йдуть у блок чату разом із профілями, а не в
  // персону, щоб персона лишалась спільним кешем для всіх чатів.
  instructions?: readonly string[];
  cacheTtl?: CacheTtl;
  // Кешувати блок останніх повідомлень: має сенс лише з якореним вікном,
  // інакше префікс не збігається ніколи.
  cacheRecent?: boolean;
};

export type LlmRequest = {
  // Масив, бо блоки кешуються окремо. Anthropic кешує префікс до кожного
  // блоку з cache_control включно, тож порядок — від найстабільнішого:
  // персона (спільна для чатів) → блок чату (інструкції + профілі) →
  // якорене вікно історії → некешований хвіст (час, гілка).
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

/**
 * Маркер для фото в історії: опис, якщо є, інакше голе «[фото]». Описи
 * альбому йдуть через «;».
 */
export function historyPhotoMarker(notes: readonly string[], count: number): string {
  if (notes.length > 0) return `[фото: ${notes.join("; ")}] `;
  if (count === 0) return "";
  return count === 1 ? "[фото] " : `[фото ×${count}] `;
}

export function buildLlmRequest(
  current: CurrentMessage,
  recent: readonly RecentMessage[],
  persona: string,
  profiles: readonly ProfileEntry[] = [],
  thread: readonly ThreadMessage[] = [],
  // Поточний час у мс. Без нього модель живе в даті свого навчання і відповідає
  // на «яке сьогодні число» навмання. Йде в змінний хвіст, тож кеш не зачіпає.
  nowMs?: number,
  opts: RequestOptions = {},
): LlmRequest {
  const cache = { type: "ephemeral" as const, ...(opts.cacheTtl ? { ttl: opts.cacheTtl } : {}) };
  // Маркери [фото N] нумеруються глобально, синхронно з порядком image-blocks
  // нижче (історія в хронологічному порядку, потім поточні фото).
  let photoCounter = 1;
  const allImages: ImageContent[] = [];
  const recentLines: string[] = [];

  for (const m of recent) {
    const photos = m.photos ?? [];
    let marker: string;
    if (photos.length > 0) {
      marker = photoMarker(photos.length, photoCounter);
      photoCounter += photos.length;
      for (const p of photos) allImages.push(toImageBlock(p));
    } else {
      marker = historyPhotoMarker(m.photoNotes ?? [], m.photoCount ?? 0);
    }
    recentLines.push(`${m.senderName}: ${marker}${m.text}`.trimEnd());
  }

  // System розколотий на блоки:
  //   [0] persona — стабільний префікс, спільний для чатів, кешуємо.
  //   [1] блок чату: інструкції + профілі — до наступної зміни, кешуємо.
  //   [2] останні повідомлення — стабільні між кроками якоря, кешуємо.
  //   [3] час + гілка — мінливий хвіст, без кешу.
  // Порожні блоки не додаємо, щоб не платити за порожній text.
  const tailSections: string[] = [];
  if (nowMs !== undefined) {
    tailSections.push(`Зараз ${formatKyivNow(nowMs)} за київським часом.`);
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

  const system: SystemBlock[] = [{ type: "text", text: persona, cache_control: cache }];
  const chatSections = [
    renderInstructionsBlock(opts.instructions ?? []),
    renderProfilesBlock(profiles),
  ].filter((s) => s.length > 0);
  if (chatSections.length > 0) {
    system.push({ type: "text", text: chatSections.join("\n\n"), cache_control: cache });
  }
  if (recentLines.length > 0) {
    system.push({
      type: "text",
      text: `Контекст останніх повідомлень у чаті:\n${recentLines.join("\n")}`,
      ...(opts.cacheRecent === false ? {} : { cache_control: cache }),
    });
  }
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
