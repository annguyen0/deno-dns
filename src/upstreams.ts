// Upstream catalog in-memory per-isolate (tra cuu hot path 0 KV) + choon thuan tu
// theo region node (anycast Deno da route den instance gan nhat → chon upstream co
// PoP cung khu vuc de giam RTT forward).
//
// - Catalog luu trong KV ["config","upstreams_catalog"] (source of truth, admin CRUD).
// - Moi isolate: lam moi cache tu KV khi init + moi chu ky poll (60s, chung voi
//   blocklist poll) + cap nhat lap tuc sau moi admin CRUD o instance do.
// - Failover tuan tu (ADR-3) giu nguyen: xuat danh sach URL theo thu tu moi.
// - (Tùy chon, cai tien ADR-3: RTT probe khi khoi dong instance — chưa viêt.)

import { UpstreamItem } from "./catalog.ts";

const CATALOG_KEY: Deno.KvKey = ["config", "upstreams_catalog"];

/**
 * Bieuu uu tien upstream theo region node (chi anh huong thu tu giua cac upstream
 * DANG BAT; upstream khong co trong bang giu nguyen thu tu catalog).
// Ma region do nen tang cung cap (verify tai task 1); chua biet ma → thu tu catalog.
 */
const REGION_PRIORITY: Record<string, string[]> = {
  eu: ["dns4eu", "cleanbrowsing", "cloudflare", "google"],
  us: ["cloudflare", "google", "opendns"],
};

const FALLBACK_URLS = [
  "https://1.1.1.1/dns-query",
  "https://dns.google/dns-query",
];

export class UpstreamCatalogCache {
  #items: UpstreamItem[] = [];

  get size(): number {
    return this.#items.length;
  }

  /** Lam moi cache tu KV (1 read). Loi → giu danh sach cu (cold start → rong). */
  async refresh(kv: Deno.Kv): Promise<void> {
    try {
      const entry = await kv.get<UpstreamItem[]>(CATALOG_KEY);
      if (entry.value && Array.isArray(entry.value)) {
        this.#items = entry.value;
      }
    } catch (e) {
      console.error("UpstreamCatalogCache: loi refresh, giu danh sach cu:", e);
    }
  }

  /** Cap nhat lap tuc sau admin CRUD (instance dang phuc vu cau hinh do). */
  setItems(items: UpstreamItem[]): void {
    this.#items = items;
  }

  /** De test: ve trang thai rong. */
  reset(): void {
    this.#items = [];
  }

  /**
   * Dong URL upstream dang bat, sap xep theo region node.
   * Catalog rong / het disabled → fallback 2 upstream mac dinh.
   */
  getActiveUpstreamUrls(nodeRegion: string | null): string[] {
    const active = this.#items.filter((u) => u.enabled).map((u) => u.url);
    if (active.length === 0) return [...FALLBACK_URLS];

    const priority = nodeRegion ? REGION_PRIORITY[nodeRegion] : undefined;
    if (!priority) return active;

    const prioritized: string[] = [];
    for (const id of priority) {
      const item = this.#items.find((u) => u.id === id);
      if (item?.enabled) prioritized.push(item.url);
    }
    const rest = active.filter((url) => !prioritized.includes(url));
    return [...prioritized, ...rest];
  }
}

export const upstreamCatalog = new UpstreamCatalogCache();
