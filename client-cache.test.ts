import { expect, test } from "bun:test";
import { ByteLruMap, TextDraftStore, type TextStorage } from "./client-cache";

test("byte LRU refreshes reads and evicts to its byte and entry budgets", () => {
  const cache = new ByteLruMap<string, string>(6, (value) => value.length, 2);
  cache.set("old", "aa").set("new", "bbb");
  expect(cache.get("old")).toBe("aa");
  cache.set("next", "ccc");
  expect([...cache.keys()]).toEqual(["old", "next"]);
  expect(cache.retainedBytes).toBe(5);
  cache.set("large", "1234567");
  expect(cache.has("large")).toBe(false);
  expect(cache.retainedBytes).toBe(5);
});

class MemoryStorage implements TextStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("text drafts persist, migrate identities, and clear only the submitted value", () => {
  const storage = new MemoryStorage();
  const first = new TextDraftStore(storage, "drafts", 128, 4);
  first.set("runtime:one", "unsent prompt");
  first.move("runtime:one", "session:/tmp/one.jsonl");
  expect(first.get("runtime:one")).toBeUndefined();
  expect(first.get("session:/tmp/one.jsonl")).toBe("unsent prompt");
  expect(first.clearIfMatches("session:/tmp/one.jsonl", "submitted old value")).toBe(false);

  const restored = new TextDraftStore(storage, "drafts", 128, 4);
  expect(restored.get("session:/tmp/one.jsonl")).toBe("unsent prompt");
  expect(restored.clearIfMatches("session:/tmp/one.jsonl", "unsent prompt")).toBe(true);
  expect(new TextDraftStore(storage, "drafts").get("session:/tmp/one.jsonl")).toBeUndefined();
});

test("text draft retention is bounded by entry count and bytes", () => {
  const storage = new MemoryStorage();
  const drafts = new TextDraftStore(storage, "drafts", 24, 2);
  drafts.set("a", "1234");
  drafts.set("b", "5678");
  drafts.set("c", "abcd");
  expect(drafts.get("a")).toBeUndefined();
  expect(drafts.get("b")).toBe("5678");
  expect(drafts.get("c")).toBe("abcd");
  drafts.set("huge", "x".repeat(20));
  expect(drafts.get("huge")).toBeUndefined();
});

test("persisted drafts are rewritten after legacy data exceeds the budget", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "drafts",
    JSON.stringify([
      ["session:oversized", "x".repeat(100)],
      ["session:kept", "draft"],
    ]),
  );
  const drafts = new TextDraftStore(storage, "drafts", 36, 2);
  expect(drafts.get("session:oversized")).toBeUndefined();
  expect(drafts.get("session:kept")).toBe("draft");
  expect(JSON.parse(storage.getItem("drafts") ?? "[]")).toEqual([
    ["session:kept", "draft"],
  ]);
});
