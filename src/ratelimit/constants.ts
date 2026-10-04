// Hang so rate-limit (ADR-2: TokenBucket in-memory per-isolate, LRU cap).

// In-Memory stores for zero-latency checks (LRU-cap)
export const MAX_TRACKED_IPS = 100_000;
export const MAX_TRACKED_LOGINS = 50_000;
export const SWEEP_INTERVAL_MS = 120_000; // chu ky quet login lockout het han

// DoH (Token Bucket: 60 req/s, Burst 120)
export const DOH_REFILL_RATE = 60; // Tokens mỗi giây
export const DOH_MAX_BURST = 120; // Số token tối đa

// Login Brute-force Protection (5 attempts / 5 mins, Lockout 15 mins)
export const MAX_LOGIN_FAILURES = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 phút

// Blocklist Sync Cooldown
export const SYNC_COOLDOWN_MS = 180_000; // 3 phút giữa các lần đồng bộ

// General API Rate Limiting (120 req/min)
export const API_REFILL_RATE = 2; // 2 req/s (~120/min)
export const API_MAX_BURST = 30;
