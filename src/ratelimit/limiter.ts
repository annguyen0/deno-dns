// Rate-limit in-memory per-isolate (ADR-2): TokenBucket DoH/API, login lockout, sync cooldown.
//
// Moi Map duoc gioi han dung luc bang LruMap (cap ~100k key) — chan tinh huong ke
// tan tao "hang triu IP" de han bo nho (plan §5.2.4). Key rate-limit nay la IP thu
// nhat duoc bo nen tang / remoteAddr (src/clientip/trust.ts), KHONG phai header client tu gan.

import {
  API_MAX_BURST,
  API_REFILL_RATE,
  DOH_MAX_BURST,
  DOH_REFILL_RATE,
  LOCKOUT_DURATION_MS,
  MAX_LOGIN_FAILURES,
  MAX_TRACKED_IPS,
  MAX_TRACKED_LOGINS,
  SWEEP_INTERVAL_MS,
  SYNC_COOLDOWN_MS,
} from "./constants.ts";

export class LruMap<K, V> {
  #map = new Map<K, V>();
  #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#map.size;
  }

  /** get duoc tinh la tro cap nhat "moi dung nhat" (LRU refresh). */
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#capacity) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }

  delete(key: K): boolean {
    return this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }

  *entries(): IterableIterator<[K, V]> {
    for (const entry of this.#map.entries()) yield entry;
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface LoginAttempt {
  failures: number;
  lockedUntil: number;
}

const dohBuckets = new LruMap<string, TokenBucket>(MAX_TRACKED_IPS);
const apiBuckets = new LruMap<string, TokenBucket>(MAX_TRACKED_IPS);
const loginAttempts = new LruMap<string, LoginAttempt>(MAX_TRACKED_LOGINS);

let lastSyncTimestamp = 0;

// DDoS Metrics for Dashboard
export const rateLimitMetrics = {
  totalDohBlocked: 0,
  totalLoginBlocked: 0,
  totalSyncBlocked: 0,
  activeTrackedIps: 0,
};

// --- DoH Rate Limiting (Token Bucket: 60 req/s, Burst 120) ---
export function checkDohRateLimit(
  ip: string,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let bucket = dohBuckets.get(ip);

  if (!bucket) {
    bucket = { tokens: DOH_MAX_BURST - 1, lastRefill: now };
    dohBuckets.set(ip, bucket);
    rateLimitMetrics.activeTrackedIps = dohBuckets.size;
    return { allowed: true };
  }

  // Refill tokens theo thời gian trôi qua
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    DOH_MAX_BURST,
    bucket.tokens + elapsedSec * DOH_REFILL_RATE,
  );
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  // Bị chặn do vượt ngưỡng
  rateLimitMetrics.totalDohBlocked++;
  const retryAfter = Math.ceil((1 - bucket.tokens) / DOH_REFILL_RATE);
  return { allowed: false, retryAfter: Math.max(1, retryAfter) };
}

// --- Login Brute-force Protection (5 attempts / 5 mins, Lockout 15 mins) ---
export function checkLoginRateLimit(
  ip: string,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);

  if (!attempt) return { allowed: true };

  if (attempt.lockedUntil > now) {
    rateLimitMetrics.totalLoginBlocked++;
    const retryAfter = Math.ceil((attempt.lockedUntil - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { failures: 0, lockedUntil: 0 };
  attempt.failures += 1;

  if (attempt.failures >= MAX_LOGIN_FAILURES) {
    attempt.lockedUntil = now + LOCKOUT_DURATION_MS;
    attempt.failures = 0; // Reset đếm sau khi khóa
  }

  loginAttempts.set(ip, attempt);
}

export function resetLoginFailure(ip: string): void {
  loginAttempts.delete(ip);
}

// --- Blocklist Sync Cooldown ---
export function checkSyncRateLimit(): {
  allowed: boolean;
  retryAfter?: number;
} {
  const now = Date.now();
  const timeSinceLast = now - lastSyncTimestamp;

  if (lastSyncTimestamp > 0 && timeSinceLast < SYNC_COOLDOWN_MS) {
    rateLimitMetrics.totalSyncBlocked++;
    const retryAfter = Math.ceil((SYNC_COOLDOWN_MS - timeSinceLast) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

export function recordSyncTriggered(): void {
  lastSyncTimestamp = Date.now();
}

// --- General API Rate Limiting (120 req/min) ---
export function checkApiRateLimit(
  ip: string,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let bucket = apiBuckets.get(ip);

  if (!bucket) {
    bucket = { tokens: API_MAX_BURST - 1, lastRefill: now };
    apiBuckets.set(ip, bucket);
    return { allowed: true };
  }

  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    API_MAX_BURST,
    bucket.tokens + elapsedSec * API_REFILL_RATE,
  );
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  const retryAfter = Math.ceil((1 - bucket.tokens) / API_REFILL_RATE);
  return { allowed: false, retryAfter: Math.max(1, retryAfter) };
}

// Periodic cleanup sweep: login lockout het han (LRU da chan tran so luong key)
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of loginAttempts) {
    if (a.lockedUntil > 0 && a.lockedUntil < now) loginAttempts.delete(ip);
  }
  rateLimitMetrics.activeTrackedIps = dohBuckets.size;
}, SWEEP_INTERVAL_MS);

export function getRateLimitStats() {
  return {
    ...rateLimitMetrics,
    activeTrackedIps: dohBuckets.size,
    lastSyncTimestamp,
  };
}
