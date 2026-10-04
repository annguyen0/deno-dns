// Chon upstream thuan tu theo region node (anycast Deno da route den instance gan
// nhat → chon upstream co PoP cung khu vuc de giam RTT forward).
//
// Failover tuan tu (ADR-3) giu nguyen: xuat danh sach URL theo thu tu moi.
// (Tùy chon, cai tien ADR-3: RTT probe khi khoi dong instance — chua viêt.)

import type { UpstreamItem } from "../types/index.ts";

/**
 * Bieu uu tien upstream theo region node (chi anh huong thu tu giua cac upstream
 * DANG BAT; upstream khong co trong bang giu nguyen thu tu catalog).
 * Ma region do nen tang cung cap (verify tai task 1); chua biet ma → thu tu catalog.
 */
export const REGION_PRIORITY: Record<string, string[]> = {
  eu: ["dns4eu", "cleanbrowsing", "cloudflare", "google"],
  us: ["cloudflare", "google", "opendns"],
};

export const FALLBACK_URLS = [
  "https://1.1.1.1/dns-query",
  "https://dns.google/dns-query",
];

/**
 * Dong URL upstream dang bat, sap xep theo region node.
 * Catalog rong / het disabled → fallback 2 upstream mac dinh.
 */
export function selectUpstreamUrls(
  items: UpstreamItem[],
  nodeRegion: string | null,
): string[] {
  const active = items.filter((u) => u.enabled).map((u) => u.url);
  if (active.length === 0) return [...FALLBACK_URLS];

  const priority = nodeRegion ? REGION_PRIORITY[nodeRegion] : undefined;
  if (!priority) return active;

  const prioritized: string[] = [];
  for (const id of priority) {
    const item = items.find((u) => u.id === id);
    if (item?.enabled) prioritized.push(item.url);
  }
  const rest = active.filter((url) => !prioritized.includes(url));
  return [...prioritized, ...rest];
}
