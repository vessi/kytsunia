import type { Api } from "grammy";
import type { PhotoCacheStore } from "../storage/photo-cache.js";

export type FetchedPhoto = {
  mime: string;
  base64: string;
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function mimeFromPath(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  const ext = dotIdx >= 0 ? path.slice(dotIdx + 1).toLowerCase() : "";
  return EXT_TO_MIME[ext] ?? "image/jpeg";
}

export type PhotoFetcherDeps = {
  api: Api;
  botToken: string;
  cache: PhotoCacheStore;
};

export type PhotoFetcher = (fileId: string, uniqueId: string) => Promise<FetchedPhoto>;

/**
 * Завантажує фото з Telegram, з кешем по unique_id. Telegram гарантує
 * стабільність file_unique_id, тож кеш-хіти безпечні безстроково.
 *
 * Telegram URL виглядає як https://api.telegram.org/file/bot<TOKEN>/<file_path>
 * і живе ≥1 година. base64 — для Anthropic image-block source.
 */
export function makePhotoFetcher(deps: PhotoFetcherDeps): PhotoFetcher {
  return async (fileId, uniqueId) => {
    const cached = deps.cache.get(uniqueId);
    if (cached) {
      return { mime: cached.mime, base64: cached.bytes.toString("base64") };
    }

    const file = await deps.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`getFile for ${fileId} returned no file_path`);
    }

    const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`telegram file download failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    const mime = mimeFromPath(file.file_path);

    deps.cache.put(uniqueId, mime, bytes);
    return { mime, base64: bytes.toString("base64") };
  };
}
