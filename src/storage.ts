import {
  BlocklistItem,
  DEFAULT_BLOCKLISTS,
  DEFAULT_UPSTREAMS,
  UpstreamItem,
} from "./catalog.ts";
import { getKv, openKv } from "./kv.ts";
import {
  BlocklistManifest,
  blocklistStore,
  MANIFEST_KEY,
  writeBlocklistSnapshot,
} from "./blocklist.ts";
import { upstreamCatalog } from "./upstreams.ts";
import { counters, initCounters } from "./counters.ts";
import { assertSafeFetchUrl, UnsafeUrlError } from "./ssrf.ts";

const POLL_INTERVAL_MS = 60_000; // chu ky kiem tra manifest moi + lam moi rules/catalog

let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface CustomRewrite {
  domain: string;
  ip: string;
}

// Khoi tao du lieu mac dinh + cache in-memory + timers nen
export async function initStorage(): Promise<void> {
  const kv = await openKv();

  // 1. Khoi tao danh mục Upstream (giu logic migration tu config cu)
  const upstreamsEntry = await kv.get<UpstreamItem[]>([
    "config",
    "upstreams_catalog",
  ]);
  if (!upstreamsEntry.value) {
    const oldUpstreams = await kv.get<string[]>(["config", "upstreams"]);
    if (oldUpstreams.value && Array.isArray(oldUpstreams.value)) {
      const merged = DEFAULT_UPSTREAMS.map((u) => ({
        ...u,
        enabled: oldUpstreams.value.includes(u.url),
      }));
      for (const oldUrl of oldUpstreams.value) {
        if (!DEFAULT_UPSTREAMS.some((u) => u.url === oldUrl)) {
          merged.push({
            id: "custom-" + crypto.randomUUID().slice(0, 8),
            name: "Custom Upstream",
            url: oldUrl,
            description: "Máy chủ DNS tùy chỉnh của bạn",
            tag: "custom",
            tagLabel: "⚙️ Tùy chỉnh",
            enabled: true,
            isCustom: true,
          });
        }
      }
      await kv.set(["config", "upstreams_catalog"], merged);
    } else {
      await kv.set(["config", "upstreams_catalog"], DEFAULT_UPSTREAMS);
    }
  } else {
    const existing = upstreamsEntry.value;
    const existingIds = new Set(existing.map((u) => u.id));
    let hasNew = false;
    for (const def of DEFAULT_UPSTREAMS) {
      if (!existingIds.has(def.id)) {
        existing.push(def);
        hasNew = true;
      }
    }
    if (hasNew) {
      await kv.set(["config", "upstreams_catalog"], existing);
    }
  }

  // 2. Khoi tao danh mục Blocklist
  const blocklistsEntry = await kv.get<BlocklistItem[]>([
    "config",
    "blocklists_catalog",
  ]);
  if (!blocklistsEntry.value) {
    await kv.set(["config", "blocklists_catalog"], DEFAULT_BLOCKLISTS);
  }

  // 3. Khoi tao cac khoa so counter (Deno.KvU64) neu chua co
  for (const key of ["total", "blocked", "allowed"]) {
    const entry = await kv.get(["stats", key]);
    if (!entry.value || !(entry.value instanceof Deno.KvU64)) {
      const initialVal = typeof entry.value === "bigint"
        ? entry.value
        : typeof entry.value === "number"
        ? BigInt(entry.value)
        : 0n;
      await kv.set(["stats", key], new Deno.KvU64(initialVal));
    }
  }

  // 4. Cache in-memory: blocklist snapshot + rules + catalog upstream + counters
  await blocklistStore.init(kv);
  await upstreamCatalog.refresh(kv);
  initCounters(kv);
  startPollLoop();
}

//Poll nen: 60s/mot lan kiem tra version blocklist moi + lam moi whitelist/rewrite/upstream
// (moi instance doc rieng — chi phi ~4 KV read/phut/instance, nhieu thep so hot path 0 op)
function startPollLoop(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    void (async () => {
      const kv = getKv();
      await blocklistStore.refresh(kv);
      await upstreamCatalog.refresh(kv);
    })();
  }, POLL_INTERVAL_MS);
}

export function stopPollLoop(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Tra cuu policy (hot path: in-memory, 0 KV op) ---
// Tra Promise (promise-compatible) de dns.ts it thay doi nhat — ben trong
// la tra cuu sync vao Set/Map (0 await).

export function isWhitelisted(domain: string): Promise<boolean> {
  return Promise.resolve(blocklistStore.isWhitelisted(domain));
}

export function isBlocked(domain: string): Promise<boolean> {
  return Promise.resolve(blocklistStore.isBlocked(domain));
}

export function getRewriteIP(domain: string): Promise<string | null> {
  return Promise.resolve(blocklistStore.getRewriteIP(domain));
}

export function getActiveUpstreamUrls(
  nodeRegion: string | null = null,
): Promise<string[]> {
  return Promise.resolve(upstreamCatalog.getActiveUpstreamUrls(nodeRegion));
}

// --- Stats (merge: tong KV global + delta chua flush cua instance dang phuc vu) ---

function parseKvU64(val: unknown): number {
  if (!val) return 0;
  if (val instanceof Deno.KvU64) return Number(val.value);
  if (typeof val === "object" && val !== null && "value" in val) {
    const inner = (val as { value: unknown }).value;
    if (typeof inner === "bigint") return Number(inner);
    if (typeof inner === "number") return inner;
  }
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "number") return val;
  return 0;
}

export async function getStats() {
  const kv = getKv();
  const totalRes = await kv.get<Deno.KvU64>(["stats", "total"]);
  const blockedRes = await kv.get<Deno.KvU64>(["stats", "blocked"]);
  const allowedRes = await kv.get<Deno.KvU64>(["stats", "allowed"]);
  const countRes = await kv.get<number>(["config", "total_blocked_count"]);

  const total = parseKvU64(totalRes.value);
  const blocked = parseKvU64(blockedRes.value);
  const allowed = parseKvU64(allowedRes.value);
  const domainCount = countRes.value || 0;

  const localDelta = counters().localDelta();

  return {
    total: total + localDelta.total,
    blocked: blocked + localDelta.blocked,
    allowed: allowed + localDelta.allowed,
    localDelta,
    domainCount,
    blocklist: blocklistStore.stats(),
    logs: counters().getLogs(),
  };
}

// --- Upstream Catalog APIs ---

export async function getUpstreamsCatalog(): Promise<UpstreamItem[]> {
  const entry = await getKv().get<UpstreamItem[]>([
    "config",
    "upstreams_catalog",
  ]);
  return entry.value || DEFAULT_UPSTREAMS;
}

export async function toggleUpstream(
  id: string,
  enabled: boolean,
): Promise<void> {
  const kv = getKv();
  const catalog = await getUpstreamsCatalog();
  const updated = catalog.map((u) => (u.id === id ? { ...u, enabled } : u));
  await kv.set(["config", "upstreams_catalog"], updated);
  upstreamCatalog.setItems(updated);
}

export async function addCustomUpstream(
  name: string,
  url: string,
): Promise<UpstreamItem> {
  const safeUrl = assertSafeFetchUrl(url);
  const kv = getKv();
  const catalog = await getUpstreamsCatalog();
  const newItem: UpstreamItem = {
    id: "custom-" + crypto.randomUUID().slice(0, 8),
    name: name.trim() || "Custom Upstream",
    url: safeUrl,
    description: "Máy chủ DoH tùy chỉnh",
    tag: "custom",
    tagLabel: "⚙️ Tùy chỉnh",
    enabled: true,
    isCustom: true,
  };
  catalog.push(newItem);
  await kv.set(["config", "upstreams_catalog"], catalog);
  upstreamCatalog.setItems(catalog);
  return newItem;
}

export async function removeUpstream(id: string): Promise<void> {
  const kv = getKv();
  const catalog = await getUpstreamsCatalog();
  const updated = catalog.filter((u) => u.id !== id);
  await kv.set(["config", "upstreams_catalog"], updated);
  upstreamCatalog.setItems(updated);
}

// --- Blocklist Catalog APIs ---

export async function getBlocklistsCatalog(): Promise<BlocklistItem[]> {
  const entry = await getKv().get<BlocklistItem[]>([
    "config",
    "blocklists_catalog",
  ]);
  return entry.value || DEFAULT_BLOCKLISTS;
}

export async function getActiveBlocklists(): Promise<BlocklistItem[]> {
  const catalog = await getBlocklistsCatalog();
  return catalog.filter((b) => b.enabled);
}

export async function toggleBlocklist(
  id: string,
  enabled: boolean,
): Promise<void> {
  const kv = getKv();
  const catalog = await getBlocklistsCatalog();
  const updated = catalog.map((b) => (b.id === id ? { ...b, enabled } : b));
  await kv.set(["config", "blocklists_catalog"], updated);
}

export async function addCustomBlocklist(
  name: string,
  url: string,
): Promise<BlocklistItem> {
  const safeUrl = assertSafeFetchUrl(url);
  const kv = getKv();
  const catalog = await getBlocklistsCatalog();
  const newItem: BlocklistItem = {
    id: "custom-" + crypto.randomUUID().slice(0, 8),
    name: name.trim() || "Custom Blocklist",
    url: safeUrl,
    description: "Nguồn danh sách chặn tùy chỉnh",
    category: "custom",
    categoryLabel: "⚙️ Tùy chỉnh",
    enabled: true,
    count: 0,
    isCustom: true,
  };
  catalog.push(newItem);
  await kv.set(["config", "blocklists_catalog"], catalog);
  return newItem;
}

export async function removeBlocklist(id: string): Promise<void> {
  const kv = getKv();
  const catalog = await getBlocklistsCatalog();
  const updated = catalog.filter((b) => b.id !== id);
  await kv.set(["config", "blocklists_catalog"], updated);
}

// --- Whitelist (KV theo tung key; hot path doc qua Set in-memory) ---

export async function getWhitelist(): Promise<string[]> {
  const list: string[] = [];
  for await (const entry of getKv().list({ prefix: ["whitelist"] })) {
    list.push(entry.key[1] as string);
  }
  return list;
}

export async function addWhitelist(domain: string) {
  const kv = getKv();
  await kv.set(["whitelist", normalizeDomain(domain)], true);
  await blocklistStore.refreshRules(kv);
}

export async function removeWhitelist(domain: string) {
  const kv = getKv();
  await kv.delete(["whitelist", normalizeDomain(domain)]);
  await blocklistStore.refreshRules(kv);
}

// --- Custom Local DNS Rewrites ---

export async function getRewrites(): Promise<CustomRewrite[]> {
  const rewrites: CustomRewrite[] = [];
  for await (const entry of getKv().list({ prefix: ["rewrites"] })) {
    rewrites.push({
      domain: entry.key[1] as string,
      ip: entry.value as string,
    });
  }
  return rewrites;
}

export async function setRewrite(domain: string, ip: string) {
  const kv = getKv();
  await kv.set(["rewrites", normalizeDomain(domain)], ip.trim());
  await blocklistStore.refreshRules(kv);
}

export async function removeRewrite(domain: string) {
  const kv = getKv();
  await kv.delete(["rewrites", normalizeDomain(domain)]);
  await blocklistStore.refreshRules(kv);
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/\.$/, "");
}

// --- Blocklist Sync (snapshot version moi thay the tron vien — plan §7) ---

/**
 * Dong bo blocklist: fetch cac nguon active (SSRF-validated, timeout 15s/nguon) →
 * parse → dedup (Set) → ghi chunks ["blocklist","v",{version},{i}] → ghi manifest CUOI.
 * Semantics moi (thay the "goi them, khong bao gio xoa" cu): snapshot version
 * thay the tron vien — domain cua nguon da tat / tai that bai bi mat khoi snapshot
 * (de sync lan sau; loi tung nguon duoc tra ve trong response).
 * Neu TAT CA nguon active deu loi → khong ghi (giu snapshot cu) va throw.
 */
export async function syncBlocklists(): Promise<{
  count: number;
  version: string;
  errors: string[];
}> {
  const kv = getKv();
  const catalog = await getBlocklistsCatalog();
  const errors: string[] = [];
  const domains = new Set<string>();
  let successCount = 0;

  for (const list of catalog) {
    if (!list.enabled) {
      list.count = 0;
      continue;
    }
    let safeUrl: string;
    try {
      safeUrl = assertSafeFetchUrl(list.url);
    } catch (e) {
      errors.push(
        `${list.name}: ${
          e instanceof UnsafeUrlError ? e.message : "URL khong hop le"
        }`,
      );
      continue;
    }
    try {
      const response = await fetch(safeUrl, {
        signal: AbortSignal.timeout(15_000), // Timeout 15s cho moi nguon
      });
      if (!response.ok) {
        errors.push(`${list.name}: HTTP ${response.status}`);
        continue;
      }

      const text = await response.text();
      let listCount = 0;
      for (const line of text.split("\n")) {
        const domain = extractDomainFromLine(line);
        if (domain) {
          domains.add(domain);
          listCount++;
        }
      }
      list.count = listCount;
      successCount++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${list.name}: ${msg}`);
      console.error(`Lỗi tải blocklist từ "${list.name}" (${list.url}):`, e);
    }
  }

  const hasActive = catalog.some((b) => b.enabled);
  if (hasActive && successCount === 0) {
    // Khong co nguon nao tai duoc → giu snapshot cu, tra loi loi
    throw new Error(`Tất cả nguồn blocklist đều lỗi: ${errors.join("; ")}`);
  }

  const oldManifest = (await kv.get<BlocklistManifest>(MANIFEST_KEY)).value;
  const manifest = await writeBlocklistSnapshot(kv, domains, oldManifest);

  await kv.set(["config", "blocklists_catalog"], catalog);
  await kv.set(["config", "total_blocked_count"], domains.size);

  // Instance hien tai ap dung ngay (khong cho chu ky poll 60s)
  await blocklistStore.refresh(kv);

  return { count: domains.size, version: manifest.version, errors };
}

// Helper trich xuat domain tu dong (ho tro hosts file, plain domain, adblock format)
function extractDomainFromLine(rawLine: string): string | null {
  let line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("!")) return null;

  // Xoa comment cuoi dong
  const hashIdx = line.indexOf("#");
  if (hashIdx !== -1) line = line.substring(0, hashIdx).trim();

  // Dạng Adblock rule: ||example.com^
  if (line.startsWith("||") && line.includes("^")) {
    const matched = line.match(/^\|\|([a-zA-Z0-9.-]+)\^/);
    if (matched) return matched[1].toLowerCase().replace(/\.$/, "");
  }

  // Dạng hosts: 0.0.0.0 example.com hoặc 127.0.0.1 example.com
  const parts = line.split(/\s+/);
  if (parts.length >= 2) {
    const domain = parts[1].toLowerCase().replace(/\.$/, "");
    if (
      domain !== "localhost" && domain !== "broadcasthost" &&
      domain.includes(".")
    ) {
      return domain;
    }
  }

  // Dạng plain domain: example.com
  if (parts.length === 1 && line.includes(".") && !line.includes("/")) {
    return line.toLowerCase().replace(/\.$/, "");
  }

  return null;
}
