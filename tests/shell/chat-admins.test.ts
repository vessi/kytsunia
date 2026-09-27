import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { makeChatAdminsCache } from "../../src/shell/chat-admins.js";

const log = pino({ level: "silent" });

describe("chatAdminsCache", () => {
  it("splits admins into everyone and those who can restrict, and caches", async () => {
    const getChatAdministrators = vi.fn(async () => [
      { status: "creator", user: { id: 1 } },
      { status: "administrator", user: { id: 2 }, can_restrict_members: true },
      { status: "administrator", user: { id: 3 }, can_restrict_members: false },
    ]);
    let t = 0;
    const cache = makeChatAdminsCache({ getChatAdministrators } as never, log, 1000, () => t);

    const first = await cache.get(-100);
    expect([...first.admins].sort()).toEqual([1, 2, 3]);
    expect([...first.moderators].sort()).toEqual([1, 2]);

    t = 500;
    await cache.get(-100);
    expect(getChatAdministrators).toHaveBeenCalledTimes(1);

    t = 1500;
    await cache.get(-100);
    expect(getChatAdministrators).toHaveBeenCalledTimes(2);
  });

  it("returns empty sets when Telegram refuses", async () => {
    const getChatAdministrators = vi.fn(async () => {
      throw new Error("chat not found");
    });
    const cache = makeChatAdminsCache({ getChatAdministrators } as never, log);
    const res = await cache.get(-100);
    expect(res.admins.size).toBe(0);
    expect(res.moderators.size).toBe(0);
  });
});
