import { describe, expect, it } from "vitest";
import { collectProfiles } from "../../../src/shell/llm/profiles.js";
import type { RecentMessageRow } from "../../../src/shell/storage/messages.js";
import type { RegularProfile, RegularsStore } from "../../../src/shell/storage/regulars.js";

function makeMockStore(profiles: RegularProfile[]): RegularsStore {
  const key = (uid: number, cid: number) => `${uid}:${cid}`;
  const map = new Map(profiles.map((p) => [key(p.userId, p.chatId), p]));
  return {
    get: (userId, chatId) => map.get(key(userId, chatId)) ?? null,
    list: () => [...map.values()],
    listByChat: (chatId) => [...map.values()].filter((p) => p.chatId === chatId),
    upsert: () => {
      // noop in mock
    },
    remove: () => false,
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
): RegularProfile {
  return {
    userId,
    chatId,
    displayName: name,
    profile,
    messageCount: 50,
    lastMessageTs: 1000,
    generatedAt: 2000,
    manualNotes: null,
  };
}

function makeMessage(senderId: number, senderName: string): RecentMessageRow {
  return { ts: 1, senderId, senderName, text: "x", kind: "text" };
}

describe("collectProfiles", () => {
  it("returns empty when no profiles match", () => {
    const store = makeMockStore([]);
    expect(collectProfiles(store, 999, 1, [], 5)).toEqual([]);
  });

  it("includes sender profile first", () => {
    const store = makeMockStore([makeProfile(100, 1, "Sender", "p1")]);
    const result = collectProfiles(store, 100, 1, [], 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Sender");
  });

  it("adds recent senders sorted by activity, after sender", () => {
    const store = makeMockStore([
      makeProfile(100, 1, "S", "sp"),
      makeProfile(200, 1, "A", "ap"),
      makeProfile(300, 1, "B", "bp"),
    ]);
    const recent = [makeMessage(200, "A"), makeMessage(200, "A"), makeMessage(300, "B")];
    const result = collectProfiles(store, 100, 1, recent, 5);
    expect(result.map((p) => p.displayName)).toEqual(["S", "A", "B"]);
  });

  it("respects limit", () => {
    const store = makeMockStore([
      makeProfile(100, 1, "S", "x"),
      makeProfile(200, 1, "A", "x"),
      makeProfile(300, 1, "B", "x"),
    ]);
    const recent = [makeMessage(200, "A"), makeMessage(300, "B")];
    expect(collectProfiles(store, 100, 1, recent, 2)).toHaveLength(2);
  });

  it("skips users without profiles", () => {
    const store = makeMockStore([makeProfile(100, 1, "S", "sp")]);
    const recent = [makeMessage(999, "Unknown")];
    const result = collectProfiles(store, 100, 1, recent, 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("S");
  });

  it("appends manual notes to profile", () => {
    const profile = makeProfile(100, 1, "S", "Base.");
    profile.manualNotes = "Special.";
    const store = makeMockStore([profile]);
    const result = collectProfiles(store, 100, 1, [], 5);
    expect(result[0]?.profile).toContain("Base.");
    expect(result[0]?.profile).toContain("Special.");
  });

  it("isolates profiles by chat", () => {
    const store = makeMockStore([
      makeProfile(100, 1, "S in chat 1", "Description for chat 1"),
      makeProfile(100, 2, "S in chat 2", "Description for chat 2"),
    ]);
    const result = collectProfiles(store, 100, 1, [], 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.profile).toContain("chat 1");
    expect(result[0]?.profile).not.toContain("chat 2");
  });
});
