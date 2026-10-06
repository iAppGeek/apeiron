import type { View } from './view.js';

export type ViewCacheOptions = {
  /** Most views kept at once. */
  maxViews: number;
  /** Most index memory (filtered, sorted and grouped arrays) kept across views, in bytes. */
  maxBytes: number;
};

export type ViewCacheStats = {
  views: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
};

/** LRU cache of views keyed by the normalised query, capped by view count and total index memory. */
export class ViewCache {
  private readonly views = new Map<string, View>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(private readonly options: ViewCacheOptions) {}

  /** Returns the view and marks it most recently used. */
  get(key: string): View | undefined {
    const view = this.views.get(key);
    if (view === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.views.delete(key);
    this.views.set(key, view);
    return view;
  }

  set(key: string, view: View): void {
    this.views.delete(key);
    this.views.set(key, view);
    this.rebalance(key);
  }

  /**
   * Evicts least recently used views until both caps hold. `keep` is never evicted, so one oversized
   * view still works. Call after a view grew (a lazily built group level or sorted leaf).
   */
  rebalance(keep: string): void {
    let bytes = this.totalBytes();
    for (const [key, view] of this.views) {
      if (this.views.size <= this.options.maxViews && bytes <= this.options.maxBytes) break;
      if (key === keep) continue;
      this.views.delete(key);
      bytes -= view.bytes;
      this.evictionCount++;
    }
  }

  clear(): void {
    this.views.clear();
  }

  has(key: string): boolean {
    return this.views.has(key);
  }

  stats(): ViewCacheStats {
    return {
      views: this.views.size,
      bytes: this.totalBytes(),
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    };
  }

  private totalBytes(): number {
    let total = 0;
    for (const v of this.views.values()) total += v.bytes;
    return total;
  }
}
