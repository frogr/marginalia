// Fixed-window per-key limiter, in memory. Fine for one small instance; a
// multi-instance deploy would need a shared store.
export class RateLimiter {
  private windows = new Map<string, { start: number; n: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds to wait, or 0 if the request is allowed (and counted). */
  hit(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, n: 1 });
      if (this.windows.size > 10_000) this.sweep(t);
      return 0;
    }
    if (w.n >= this.limit) return Math.ceil((w.start + this.windowMs - t) / 1000);
    w.n++;
    return 0;
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
