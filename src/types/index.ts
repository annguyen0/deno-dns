// Giao dien shared giua cac module (plan §4.6: src/types/ — all shared interfaces).
// Chi dat tai day nhung interface duoc dung boi ≥ 2 module; interface noi bo van
// o ben trong module do.

// --- Client IP (clientip/trust.ts, api/, diag/) ---
export interface ClientInfo {
  /** IP client dang tin (public, xac real duoc bo nen tang). null = khong xac dinh duoc. */
  ip: string | null;
  /** Ma region/colo cua node Deno dang xu ly (nen tang khong cung cap thi null). */
  nodeRegion: string | null;
}

// --- Counters (counters/, storage/, dns/) ---
export type QueryStatus = "ALLOWED" | "BLOCKED" | "WHITELISTED" | "REWRITE";

export interface LogEntry {
  time: string;
  domain: string;
  status: QueryStatus;
  clientIp: string;
}

export interface LocalDelta {
  total: number;
  blocked: number;
  allowed: number;
}

// --- Blocklist snapshot (blocklist/, storage/) ---
export interface VersionRef {
  version: string;
  chunkCount: number;
}

export interface BlocklistManifest {
  version: string;
  /** Cac version con co chunk trong KV (mới nhat truoc), toc dai 2 — de doi instance
   *  chua kịp reload van tai duoc ban cu. */
  versions: VersionRef[];
  totalDomains: number;
  createdAt: number;
}

// --- Admin API (api/, storage/) ---
export interface CustomRewrite {
  domain: string;
  ip: string;
}

// --- Catalog items (upstream/catalog.ts, storage/, api/) ---
export interface UpstreamItem {
  id: string;
  name: string;
  url: string;
  description: string;
  tag: "speed" | "security" | "adblock" | "family" | "custom";
  tagLabel: string;
  enabled: boolean;
  isCustom?: boolean;
}

export interface BlocklistItem {
  id: string;
  name: string;
  url: string;
  description: string;
  category: "vn" | "general" | "privacy" | "malware" | "custom";
  categoryLabel: string;
  enabled: boolean;
  count?: number;
  isCustom?: boolean;
}
