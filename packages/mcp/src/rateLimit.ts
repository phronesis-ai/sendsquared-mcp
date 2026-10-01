import { createHash } from "node:crypto"
import type { Request, Response, NextFunction } from "express"
import { extractBearer } from "./auth.js"

interface Bucket {
  tokens: number
  lastRefill: number
}

/*
  Per-token token-bucket rate limiter. Two independent buckets per bearer:
    - burst: 10 tokens, refills at 10/sec
    - sustained: 100 tokens, refills at ~1.67/sec (100/min)
  A request must draw from both buckets. This is defensive throttling: the
  SendSquared backend currently has no API-wide rate limiting (Roy's work),
  and a runaway agent session could otherwise hammer api.sendsquared.com
  indefinitely. Buckets live in memory keyed by SHA-256(token), so rotating
  the token gives the user a fresh allowance. Single EC2 box means we don't
  need cross-instance coherency — when we scale we'll swap to Redis.
*/
const BURST_CAPACITY = 10
const BURST_REFILL_PER_SEC = 10
const SUSTAINED_CAPACITY = 100
const SUSTAINED_REFILL_PER_SEC = 100 / 60

const MAX_BUCKETS = 10000

const burstBuckets = new Map<string, Bucket>()
const sustainedBuckets = new Map<string, Bucket>()

function refill(bucket: Bucket, capacity: number, refillPerSec: number): void {
  const now = Date.now()
  const elapsedSec = (now - bucket.lastRefill) / 1000
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec)
  bucket.lastRefill = now
}

function evictOldest(buckets: Map<string, Bucket>): void {
  let oldestKey: string | undefined
  let oldestTime = Infinity
  for (const [k, v] of buckets) {
    if (v.lastRefill < oldestTime) {
      oldestTime = v.lastRefill
      oldestKey = k
    }
  }
  if (oldestKey) buckets.delete(oldestKey)
}

function drawFromBucket(
  buckets: Map<string, Bucket>,
  key: string,
  capacity: number,
  refillPerSec: number,
): boolean {
  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) evictOldest(buckets)
    bucket = { tokens: capacity, lastRefill: Date.now() }
    buckets.set(key, bucket)
  }
  refill(bucket, capacity, refillPerSec)
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function keyFor(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function perTokenRateLimit(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearer(req)
  if (!token) {
    next()
    return
  }

  const key = keyFor(token)
  const burstOk = drawFromBucket(burstBuckets, key, BURST_CAPACITY, BURST_REFILL_PER_SEC)
  const sustainedOk = drawFromBucket(sustainedBuckets, key, SUSTAINED_CAPACITY, SUSTAINED_REFILL_PER_SEC)

  if (!burstOk || !sustainedOk) {
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: burstOk
          ? "Rate limit: sustained cap of 100 requests/minute exceeded for this token. Slow down or wait a minute."
          : "Rate limit: burst cap of 10 requests/second exceeded for this token. Slow down.",
      },
      id: null,
    })
    return
  }

  next()
}

const rateLimitSweep = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [k, v] of burstBuckets) if (v.lastRefill < cutoff) burstBuckets.delete(k)
  for (const [k, v] of sustainedBuckets) if (v.lastRefill < cutoff) sustainedBuckets.delete(k)
}, 10 * 60 * 1000)
rateLimitSweep.unref()
