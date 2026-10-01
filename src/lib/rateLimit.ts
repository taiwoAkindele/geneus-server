/**
 * A fixed-window counter per key, in memory. Enough for the one server process
 * this deployment runs (PLAN.md §2): it guards the few endpoints a caller can
 * reach without a device credential, where the only thing between a guesser
 * and a valid invite or enrollment code is how many guesses they get. A
 * second process would need a shared store — that is the trigger to revisit.
 */
export type RateLimiter = {
  /** Counts one attempt; returns the seconds to wait when over the limit, otherwise undefined. */
  hit: (key: string, now?: number) => number | undefined;
};

/** Expired windows are swept once the map grows past this, so idle keys cannot pile up. */
const SWEEP_THRESHOLD = 10_000;

export const createRateLimiter = (limit: number, windowMs: number): RateLimiter => {
  const windows = new Map<string, { count: number; resetsAt: number }>();

  const sweep = (now: number) => {
    for (const [key, window] of windows) if (window.resetsAt <= now) windows.delete(key);
  };

  return {
    hit: (key, now = Date.now()) => {
      if (windows.size > SWEEP_THRESHOLD) sweep(now);
      const window = windows.get(key);
      if (!window || window.resetsAt <= now) {
        windows.set(key, { count: 1, resetsAt: now + windowMs });
        return undefined;
      }
      window.count += 1;
      return window.count > limit ? Math.ceil((window.resetsAt - now) / 1000) : undefined;
    },
  };
};
