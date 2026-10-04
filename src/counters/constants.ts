// Hang so flush counter (plan §7: flush gom 3 khoa KvU64 trong 1 atomic commit).

export const FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_DELTA_THRESHOLD = 10_000;
export const LOG_RING_SIZE = 50;
