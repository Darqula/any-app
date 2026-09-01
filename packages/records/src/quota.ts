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
 * A per-app token bucket, entirely in this process's memory. Say so here so nobody "fixes"
 * it into something it isn't: it is per-process, so it becomes ineffective the moment the
 * sandbox runs more than one instance — the replacement then is a shared counter, not a
 * bigger Map. See .docs/impl-phase-5.md's "Deliberately deferred".
 */
const buckets = new Map<string, Bucket>();

function capacity(kind: RateKind): number {
  return kind === "read" ? READS_PER_MINUTE : WRITES_PER_MINUTE;
}

/**
 * True if this call is allowed right now, consuming one token if so. False means the caller
 * should respond 429. Refills continuously (capacity tokens per 60s) rather than in fixed
 * windows, so a burst right at a window boundary can't double an app's effective rate.
 */
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
 * Bounds `buckets`' lifetime growth (Phase 5 review, "Minor"). Every app ever served gets up
 * to two entries (read, write) that otherwise live for the process's whole lifetime, even
 * once an app stops being called entirely — `checkRate` only ever touches a key when a
 * request for it arrives, so nothing inside `checkRate` itself can clean up an app that's
 * gone quiet. A periodic sweep is what actually bounds this: refill each bucket as of now,
 * and drop it if that refill brings it back to full — full is exactly the state `checkRate`
 * reconstructs for a key it's never seen, so dropping it loses no information.
 *
 * `unref()` so this timer alone never keeps the process alive.
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
