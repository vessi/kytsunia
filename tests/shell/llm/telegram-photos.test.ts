import type { Api } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePhotoFetcher } from "../../../src/shell/llm/telegram-photos.js";
import type { PhotoCacheStore } from "../../../src/shell/storage/photo-cache.js";

function makeMemoryCache(): PhotoCacheStore {
  const map = new Map<string, { mime: string; bytes: Buffer }>();
  return {
    get: (id) => map.get(id) ?? null,
    put: (id, mime, bytes) => {
      map.set(id, { mime, bytes });
    },
  };
}

describe("makePhotoFetcher", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses cache on hit, no network call", async () => {
    const cache = makeMemoryCache();
    const original = Buffer.from([0xff, 0xd8, 0xff]);
    cache.put("u1", "image/jpeg", original);

    const getFile = vi.fn();
    const api = { getFile } as unknown as Api;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const fetcher = makePhotoFetcher({ api, botToken: "t", cache });
    const result = await fetcher("file-id-x", "u1");

    expect(result.mime).toBe("image/jpeg");
    expect(result.base64).toBe(original.toString("base64"));
    expect(getFile).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("downloads on miss and writes to cache", async () => {
    const cache = makeMemoryCache();
    const bodyBytes = new Uint8Array([1, 2, 3, 4]);
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/abc.png" });
    const api = { getFile } as unknown as Api;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(bodyBytes, { status: 200 })) as unknown as typeof fetch;

    const fetcher = makePhotoFetcher({ api, botToken: "TOKEN", cache });
    const result = await fetcher("FID", "U1");

    expect(getFile).toHaveBeenCalledWith("FID");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTOKEN/photos/abc.png",
    );
    expect(result.mime).toBe("image/png");
    expect(result.base64).toBe(Buffer.from(bodyBytes).toString("base64"));

    // Записалось у кеш
    expect(cache.get("U1")).not.toBeNull();
  });

  it("infers mime from .jpg extension", async () => {
    const cache = makeMemoryCache();
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/foo.jpg" });
    const api = { getFile } as unknown as Api;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200 }),
      ) as unknown as typeof fetch;

    const fetcher = makePhotoFetcher({ api, botToken: "T", cache });
    const result = await fetcher("F", "U");
    expect(result.mime).toBe("image/jpeg");
  });

  it("throws when getFile returns no file_path", async () => {
    const cache = makeMemoryCache();
    const api = { getFile: vi.fn().mockResolvedValue({}) } as unknown as Api;
    const fetcher = makePhotoFetcher({ api, botToken: "T", cache });
    await expect(fetcher("F", "U")).rejects.toThrow(/no file_path/);
  });

  it("throws on non-2xx response", async () => {
    const cache = makeMemoryCache();
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/x.jpg" }),
    } as unknown as Api;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 404, statusText: "Not Found" }),
      ) as unknown as typeof fetch;

    const fetcher = makePhotoFetcher({ api, botToken: "T", cache });
    await expect(fetcher("F", "U")).rejects.toThrow(/404/);
  });

  it("falls back to image/jpeg for unknown extension", async () => {
    const cache = makeMemoryCache();
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/foo.bin" }),
    } as unknown as Api;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { status: 200 }),
      ) as unknown as typeof fetch;

    const fetcher = makePhotoFetcher({ api, botToken: "T", cache });
    const result = await fetcher("F", "U");
    expect(result.mime).toBe("image/jpeg");
  });
});
