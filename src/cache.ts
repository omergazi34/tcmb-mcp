/** A small LRU cache with optional per-entry TTL. Map preserves insertion order, which is the LRU order. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (maxEntries < 1) throw new RangeError("maxEntries must be >= 1");
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key); // refresh recency
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = Number.POSITIVE_INFINITY): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
