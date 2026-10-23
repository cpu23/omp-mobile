export class ByteLruMap<K, V> implements Iterable<[K, V]> {
  private readonly entries = new Map<K, { value: V; bytes: number }>();
  private bytes = 0;

  constructor(
    readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
    readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("maxBytes must be a non-negative safe integer");
    if (!(maxEntries > 0))
      throw new RangeError("maxEntries must be positive");
  }

  get size(): number {
    return this.entries.size;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, retainedBytes?: number): this {
    this.delete(key);
    const bytes = retainedBytes ?? this.sizeOf(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("cache entry size must be a non-negative safe integer");
    if (bytes > this.maxBytes || this.maxBytes === 0) return this;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }


  *[Symbol.iterator](): Iterator<[K, V]> {
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }
}

export interface TextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Bounded local text draft retention, with LRU eviction and identity migration. */
export class TextDraftStore {
  private readonly drafts = new Map<string, string>();

  constructor(
    private readonly storage: TextStorage,
    private readonly storageKey: string,
    readonly maxBytes = 128 * 1024,
    readonly maxEntries = 64,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("maxBytes must be a non-negative safe integer");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new RangeError("maxEntries must be a positive safe integer");
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.persist();
        return;
      }
      for (const entry of parsed) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          typeof entry[1] === "string"
        )
          this.drafts.set(entry[0], entry[1]);
      }
      const entryCount = this.drafts.size;
      this.trim();
      if (this.drafts.size !== entryCount) this.persist();
    } catch {
      this.drafts.clear();
      this.persist();
    }
  }

  get(key: string): string | undefined {
    const value = this.drafts.get(key);
    if (value === undefined) return undefined;
    this.drafts.delete(key);
    this.drafts.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (!key) return;
    this.drafts.delete(key);
    if (value) this.drafts.set(key, value);
    this.trim();
    this.persist();
  }

  move(from: string, to: string): void {
    if (!from || !to || from === to) return;
    const value = this.drafts.get(from);
    if (value === undefined) return;
    this.drafts.delete(from);
    this.drafts.delete(to);
    this.drafts.set(to, value);
    this.trim();
    this.persist();
  }

  clearIfMatches(key: string, expected: string): boolean {
    if (!key || this.drafts.get(key) !== expected) return false;
    this.drafts.delete(key);
    this.persist();
    return true;
  }

  delete(key: string): void {
    if (this.drafts.delete(key)) this.persist();
  }

  private trim(): void {
    const bytes = (): number => {
      let total = 0;
      for (const [key, value] of this.drafts)
        total += (key.length + value.length) * 2;
      return total;
    };
    while (
      this.drafts.size > this.maxEntries ||
      bytes() > this.maxBytes
    ) {
      const oldest = this.drafts.keys().next().value;
      if (oldest === undefined) break;
      this.drafts.delete(oldest);
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify(Array.from(this.drafts.entries())),
      );
    } catch {
      // Storage can be unavailable or full; the in-memory draft remains usable.
    }
  }
}
