interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface LoginAttempt {
  failures: number;
  lockedUntil: number;
}

// In-Memory stores for zero-latency checks
const dohBuckets = new Map<string, TokenBucket>();
const loginAttempts = new Map<string, LoginAttempt>();
const apiBuckets = new Map<string, TokenBucket>();

let lastSyncTimestamp = 0;
const SYNC_COOLDOWN_MS = 180_000; // 3 phút cooldown giữa các lần đồng bộ blocklist

// DDoS Metrics for Dashboard
export const rateLimitMetrics = {
  totalDohBlocked: 0,
  totalLoginBlocked: 0,
  totalSyncBlocked: 0,
  activeTrackedIps: 0,
};

// --- DoH Rate Limiting (Token Bucket: 60 req/s, Burst 120) ---
const DOH_REFILL_RATE = 60; // Tokens mỗi giây
const DOH_MAX_BURST = 120; // Số token tối đa

export function checkDohRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
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
  bucket.tokens = Math.min(DOH_MAX_BURST, bucket.tokens + elapsedSec * DOH_REFILL_RATE);
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
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 phút

export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
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
export function checkSyncRateLimit(): { allowed: boolean; retryAfter?: number } {
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
const API_REFILL_RATE = 2; // 2 req/s (~120/min)
const API_MAX_BURST = 30;

export function checkApiRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  let bucket = apiBuckets.get(ip);

  if (!bucket) {
    bucket = { tokens: API_MAX_BURST - 1, lastRefill: now };
    apiBuckets.set(ip, bucket);
    return { allowed: true };
  }

  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(API_MAX_BURST, bucket.tokens + elapsedSec * API_REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  const retryAfter = Math.ceil((1 - bucket.tokens) / API_REFILL_RATE);
  return { allowed: false, retryAfter: Math.max(1, retryAfter) };
}

// Periodic cleanup sweep to prevent memory growth (chạy mỗi 2 phút)
setInterval(() => {
  const now = Date.now();
  // Xóa các bucket DoH không hoạt động trên 5 phút
  for (const [ip, b] of dohBuckets.entries()) {
    if (now - b.lastRefill > 300_000) dohBuckets.delete(ip);
  }
  // Xóa các login attempts đã hết hạn khóa
  for (const [ip, a] of loginAttempts.entries()) {
    if (a.lockedUntil > 0 && a.lockedUntil < now) loginAttempts.delete(ip);
  }
  for (const [ip, b] of apiBuckets.entries()) {
    if (now - b.lastRefill > 300_000) apiBuckets.delete(ip);
  }
  rateLimitMetrics.activeTrackedIps = dohBuckets.size;
}, 120_000);

export function getRateLimitStats() {
  return {
    ...rateLimitMetrics,
    activeTrackedIps: dohBuckets.size,
    lastSyncTimestamp,
  };
}
