export const MAX_RECORDS_PER_APP = 1000;
export const MAX_RECORD_BYTES = 65_536;
const WRITES_PER_MINUTE = 60;
const READS_PER_MINUTE = 300;

type RateKind = "read" | "write";

interface Bucket {
  tokens: number;
  lastRefill: number;
  /** This bucket's own capacity, so a sweep (below) can judge "full" without re-deriving it
   *  from the key string. */
  max: number;
}

/**
 * Per-app token bucket in process memory. Ineffective across several sandbox instances; the fix then is a
 * shared counter.
 */
const buckets = new Map<string, Bucket>();

function capacity(kind: RateKind): number {
  return kind === "read" ? READS_PER_MINUTE : WRITES_PER_MINUTE;
}

/** True if allowed (consumes a token). Refills continuously so a window boundary cannot double the rate. */
export function checkRate(appId: string, kind: RateKind): boolean {
  const key = `${appId}:${kind}`;
  const max = capacity(kind);
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: max, lastRefill: now, max };
    buckets.set(key, bucket);
  }

  const elapsedMs = now - bucket.lastRefill;
  if (elapsedMs > 0) {
    bucket.tokens = Math.min(max, bucket.tokens + (elapsedMs / 60_000) * max);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Drops buckets that have refilled to full, which is what an unseen key looks like, so growth stays bounded.
 * unref() so the timer never keeps the process alive.
 */
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    const elapsedMs = now - bucket.lastRefill;
    const tokens = Math.min(bucket.max, bucket.tokens + (elapsedMs / 60_000) * bucket.max);
    if (tokens >= bucket.max) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();
