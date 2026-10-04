// Hang so auth (PBKDF2 + session TTL).

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày
export const PBKDF2_ITERATIONS = 100_000;
