import { describe, expect, it } from "vitest";
import { collectChatProfiles, renderProfilesBlock } from "../../../src/shell/llm/profiles.js";
import type { RegularProfile, RegularsStore } from "../../../src/shell/storage/regulars.js";

function makeMockStore(profiles: RegularProfile[]): RegularsStore {
  const key = (uid: number, cid: number) => `${uid}:${cid}`;
  const map = new Map(profiles.map((p) => [key(p.userId, p.chatId), p]));
  return {
    get: (userId, chatId) => map.get(key(userId, chatId)) ?? null,
    list: () => [...map.values()],
    // Як у справжньому сховищі: за активністю, від найбільшої.
    listByChat: (chatId) =>
      [...map.values()]
        .filter((p) => p.chatId === chatId)
        .sort((a, b) => b.messageCount - a.messageCount),
    upsert: () => {
      // noop in mock
    },
    remove: () => false,
    removeAllForUser: () => 0,
    setManualNotes: () => {
      // noop in mock
    },
  };
}

function makeProfile(
  userId: number,
  chatId: number,
  name: string,
  profile: string,
  extra: Partial<RegularProfile> = {},
): RegularProfile {
  return {
    userId,
    chatId,
    displayName: name,
    profile,
    messageCount: 10,
    lastMessageTs: null,
    generatedAt: 0,
    manualNotes: null,
    ...extra,
  };
}

describe("collectChatProfiles", () => {
  it("returns empty when the chat has no profiles", () => {
    expect(collectChatProfiles(makeMockStore([]), 1)).toEqual([]);
  });

  it("returns every profile of the chat, most active first, regardless of who is talking", () => {
    const store = makeMockStore([
      makeProfile(100, 1, "Quiet", "q", { messageCount: 5 }),
      makeProfile(101, 1, "Loud", "l", { messageCount: 50 }),
      makeProfile(102, 2, "Elsewhere", "e", { messageCount: 500 }),
    ]);
    expect(collectChatProfiles(store, 1).map((p) => p.displayName)).toEqual(["Loud", "Quiet"]);
  });

  it("appends manual notes to the profile text", () => {
    const store = makeMockStore([
      makeProfile(100, 1, "Olha", "Бігає.", { manualNotes: "Без «тітко»." }),
    ]);
    expect(collectChatProfiles(store, 1)[0]?.profile).toBe(
      "Бігає.\n\nДодаткові примітки: Без «тітко».",
    );
  });

  it("falls back to Unknown without a display name", () => {
    const store = makeMockStore([makeProfile(100, 1, "x", "p", { displayName: null })]);
    expect(collectChatProfiles(store, 1)[0]?.displayName).toBe("Unknown");
  });
});

describe("renderProfilesBlock", () => {
  it("is empty without profiles", () => {
    expect(renderProfilesBlock([])).toBe("");
  });

  it("renders a header and one entry per person", () => {
    expect(
      renderProfilesBlock([
        { displayName: "A", profile: "a" },
        { displayName: "B", profile: "b" },
      ]),
    ).toBe("Профілі учасників (для розуміння стилю і інтересів):\n\nA:\na\n\nB:\nb");
  });
});
