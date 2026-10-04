// Mau schema Deno KV — nguon duy nhat dinh nghia ten khoa (plan §4.2 kv/schema.ts,
// §7). Mot khi khoa duoc dat o day, khong duoc dat ten truc tiep o module khac.
//
// Hien tai KV co 2 nhom:
// 1. Blocklist snapshot (MVCC): ["blocklist","manifest"] + ["blocklist","v",{version},{i}]
// 2. Rules/catalog/counts theo tung key: whitelist/*, rewrites/*, config/*, stats/*, ...
// Khoa cu ["blocked_domains", ...] da bi loai bo khoi code — con ton tai tren KV cu
// thi chay `deno task migrate-kv` de xoa (src/kv/migration.ts).

// --- Blocklist snapshot (MVCC) ---
export const MANIFEST_KEY: Deno.KvKey = ["blocklist", "manifest"];

export function chunkKey(version: string, index: number): Deno.KvKey {
  return ["blocklist", "v", version, index];
}

/** Khoa legacy blocklist phang — chi de migrate xoa (khong doc/ghi nua). */
export const LEGACY_BLOCKED_PREFIX: Deno.KvKey = ["blocked_domains"];

// --- Rules (admin CRUD; hot path doc qua Set/Map in-memory) ---
export const WHITELIST_PREFIX: Deno.KvKey = ["whitelist"];
export function whitelistKey(domain: string): Deno.KvKey {
  return ["whitelist", domain];
}

export const REWRITES_PREFIX: Deno.KvKey = ["rewrites"];
export function rewriteKey(domain: string): Deno.KvKey {
  return ["rewrites", domain];
}

// --- Counters (KvU64, flush atomic sum 3 khoa) ---
export const STATS_KEYS: Record<"total" | "blocked" | "allowed", Deno.KvKey> = {
  total: ["stats", "total"],
  blocked: ["stats", "blocked"],
  allowed: ["stats", "allowed"],
};

// --- Catalogs & config ---
export const CONFIG_KEYS = {
  upstreamsCatalog: ["config", "upstreams_catalog"] as Deno.KvKey,
  upstreamsLegacy: ["config", "upstreams"] as Deno.KvKey,
  blocklistsCatalog: ["config", "blocklists_catalog"] as Deno.KvKey,
  totalBlockedCount: ["config", "total_blocked_count"] as Deno.KvKey,
};

// --- Auth ---
export const AUTH_PASSWORD_KEY: Deno.KvKey = ["auth", "password_hash"];
export function sessionKey(sessionId: string): Deno.KvKey {
  return ["sessions", sessionId];
}
