import {
  BlocklistItem,
  DEFAULT_BLOCKLISTS,
  DEFAULT_UPSTREAMS,
  UpstreamItem,
} from "./catalog.ts";

const kv = await Deno.openKv();

export interface CustomRewrite {
  domain: string;
  ip: string;
}

// Khởi tạo dữ liệu mặc định
export async function initStorage() {
  // 1. Khởi tạo danh mục Upstream tuyển chọn
  const upstreamsEntry = await kv.get<UpstreamItem[]>(["config", "upstreams_catalog"]);
  if (!upstreamsEntry.value) {
    // Nếu có config cũ dạng string[], chuyển đổi sang cấu trúc mới
    const oldUpstreams = await kv.get<string[]>(["config", "upstreams"]);
    if (oldUpstreams.value && Array.isArray(oldUpstreams.value)) {
      const merged = DEFAULT_UPSTREAMS.map((u) => ({
        ...u,
        enabled: oldUpstreams.value.includes(u.url),
      }));
      // Thêm các custom upstream cũ nếu có
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
  }

  // 2. Khởi tạo danh mục Blocklist tuyển chọn
  const blocklistsEntry = await kv.get<BlocklistItem[]>(["config", "blocklists_catalog"]);
  if (!blocklistsEntry.value) {
    await kv.set(["config", "blocklists_catalog"], DEFAULT_BLOCKLISTS);
  }

  // 3. Khởi tạo và đồng bộ hóa các bộ đếm thống kê đảm bảo kiểu Deno.KvU64
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
}

// Thống kê & Logs
export async function recordStat(
  domain: string,
  status: "ALLOWED" | "BLOCKED" | "WHITELISTED" | "REWRITE",
  clientIp: string
) {
  try {
    const isBlocked = status === "BLOCKED";
    const typeKey = isBlocked ? "blocked" : "allowed";

    await kv.atomic()
      .mutate({ type: "sum", key: ["stats", "total"], value: new Deno.KvU64(1n) })
      .mutate({ type: "sum", key: ["stats", typeKey], value: new Deno.KvU64(1n) })
      .commit();

    const timestamp = Date.now();
    const id = crypto.randomUUID();

    await kv.set(["logs", timestamp, id], {
      id,
      time: new Date(timestamp).toLocaleTimeString("vi-VN"),
      domain,
      status,
      clientIp,
    });
  } catch (e) {
    console.error("Lỗi ghi log:", e);
  }
}

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
  const totalRes = await kv.get<Deno.KvU64>(["stats", "total"]);
  const blockedRes = await kv.get<Deno.KvU64>(["stats", "blocked"]);
  const allowedRes = await kv.get<Deno.KvU64>(["stats", "allowed"]);
  const countRes = await kv.get<number>(["config", "total_blocked_count"]);

  const total = parseKvU64(totalRes.value);
  const blocked = parseKvU64(blockedRes.value);
  const allowed = parseKvU64(allowedRes.value);
  const domainCount = countRes.value || 0;

  const logs = [];
  for await (const entry of kv.list({ prefix: ["logs"] }, { limit: 50, reverse: true })) {
    if (entry.value) {
      logs.push(entry.value);
    }
  }

  return { total, blocked, allowed, domainCount, logs };
}

// --- Upstream Catalog APIs ---

export async function getUpstreamsCatalog(): Promise<UpstreamItem[]> {
  const entry = await kv.get<UpstreamItem[]>(["config", "upstreams_catalog"]);
  return entry.value || DEFAULT_UPSTREAMS;
}

export async function getActiveUpstreamUrls(): Promise<string[]> {
  const catalog = await getUpstreamsCatalog();
  const active = catalog.filter((u) => u.enabled).map((u) => u.url);
  if (active.length === 0) {
    return ["https://1.1.1.1/dns-query", "https://dns.google/dns-query"];
  }
  return active;
}

export async function toggleUpstream(id: string, enabled: boolean): Promise<void> {
  const catalog = await getUpstreamsCatalog();
  const updated = catalog.map((u) => (u.id === id ? { ...u, enabled } : u));
  await kv.set(["config", "upstreams_catalog"], updated);
}

export async function addCustomUpstream(name: string, url: string): Promise<UpstreamItem> {
  const catalog = await getUpstreamsCatalog();
  const newItem: UpstreamItem = {
    id: "custom-" + crypto.randomUUID().slice(0, 8),
    name: name.trim() || "Custom Upstream",
    url: url.trim(),
    description: "Máy chủ DoH tùy chỉnh",
    tag: "custom",
    tagLabel: "⚙️ Tùy chỉnh",
    enabled: true,
    isCustom: true,
  };
  catalog.push(newItem);
  await kv.set(["config", "upstreams_catalog"], catalog);
  return newItem;
}

export async function removeUpstream(id: string): Promise<void> {
  const catalog = await getUpstreamsCatalog();
  const updated = catalog.filter((u) => u.id !== id);
  await kv.set(["config", "upstreams_catalog"], updated);
}

// --- Blocklist Catalog APIs ---

export async function getBlocklistsCatalog(): Promise<BlocklistItem[]> {
  const entry = await kv.get<BlocklistItem[]>(["config", "blocklists_catalog"]);
  return entry.value || DEFAULT_BLOCKLISTS;
}

export async function getActiveBlocklists(): Promise<BlocklistItem[]> {
  const catalog = await getBlocklistsCatalog();
  return catalog.filter((b) => b.enabled);
}

export async function toggleBlocklist(id: string, enabled: boolean): Promise<void> {
  const catalog = await getBlocklistsCatalog();
  const updated = catalog.map((b) => (b.id === id ? { ...b, enabled } : b));
  await kv.set(["config", "blocklists_catalog"], updated);
}

export async function addCustomBlocklist(name: string, url: string): Promise<BlocklistItem> {
  const catalog = await getBlocklistsCatalog();
  const newItem: BlocklistItem = {
    id: "custom-" + crypto.randomUUID().slice(0, 8),
    name: name.trim() || "Custom Blocklist",
    url: url.trim(),
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
  const catalog = await getBlocklistsCatalog();
  const updated = catalog.filter((b) => b.id !== id);
  await kv.set(["config", "blocklists_catalog"], updated);
}

// Whitelist
export async function getWhitelist(): Promise<string[]> {
  const list: string[] = [];
  for await (const entry of kv.list({ prefix: ["whitelist"] })) {
    list.push(entry.key[1] as string);
  }
  return list;
}

export async function addWhitelist(domain: string) {
  await kv.set(["whitelist", domain.toLowerCase().trim().replace(/\.$/, "")], true);
}

export async function removeWhitelist(domain: string) {
  await kv.delete(["whitelist", domain.toLowerCase().trim().replace(/\.$/, "")]);
}

export async function isWhitelisted(domain: string): Promise<boolean> {
  const clean = domain.toLowerCase().trim().replace(/\.$/, "");
  if (!clean) return false;
  const parts = clean.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const res = await kv.get(["whitelist", candidate]);
    if (res.value) return true;
  }
  return false;
}

// Custom Local DNS Rewrites
export async function getRewrites(): Promise<CustomRewrite[]> {
  const rewrites: CustomRewrite[] = [];
  for await (const entry of kv.list({ prefix: ["rewrites"] })) {
    rewrites.push({ domain: entry.key[1] as string, ip: entry.value as string });
  }
  return rewrites;
}

export async function setRewrite(domain: string, ip: string) {
  await kv.set(["rewrites", domain.toLowerCase().trim().replace(/\.$/, "")], ip.trim());
}

export async function removeRewrite(domain: string) {
  await kv.delete(["rewrites", domain.toLowerCase().trim().replace(/\.$/, "")]);
}

export async function getRewriteIP(domain: string): Promise<string | null> {
  const clean = domain.toLowerCase().trim().replace(/\.$/, "");
  if (!clean) return null;
  const res = await kv.get<string>(["rewrites", clean]);
  if (res.value) return res.value;

  const parts = clean.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const wildcard = "*." + parts.slice(i).join(".");
    const wildRes = await kv.get<string>(["rewrites", wildcard]);
    if (wildRes.value) return wildRes.value;
  }
  return null;
}

// Blocklist Engine
export async function isBlocked(domain: string): Promise<boolean> {
  const clean = domain.toLowerCase().trim().replace(/\.$/, "");
  if (!clean) return false;
  const parts = clean.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const res = await kv.get(["blocked_domains", candidate]);
    if (res.value) return true;
  }
  return false;
}

// Helper trích xuất domain từ dòng (hỗ trợ hosts file, plain domain, adblock format)
function extractDomainFromLine(rawLine: string): string | null {
  let line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("!")) return null;

  // Xóa comment cuối dòng
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
    if (domain !== "localhost" && domain !== "broadcasthost" && domain.includes(".")) {
      return domain;
    }
  }

  // Dạng plain domain: example.com
  if (parts.length === 1 && line.includes(".") && !line.includes("/")) {
    return line.toLowerCase().replace(/\.$/, "");
  }

  return null;
}

export async function syncBlocklists(): Promise<number> {
  const catalog = await getBlocklistsCatalog();
  const activeLists = catalog.filter((b) => b.enabled);
  let totalUniqueDomains = 0;

  for (const list of catalog) {
    if (!list.enabled) {
      list.count = 0;
      continue;
    }

    try {
      const response = await fetch(list.url, {
        signal: AbortSignal.timeout(15_000), // Timeout 15s cho mỗi nguồn
      });
      if (!response.ok) continue;

      const text = await response.text();
      let atomic = kv.atomic();
      let batchCount = 0;
      let listCount = 0;

      for (const line of text.split("\n")) {
        const domain = extractDomainFromLine(line);
        if (domain) {
          atomic.set(["blocked_domains", domain], true);
          listCount++;
          totalUniqueDomains++;
          batchCount++;

          if (batchCount >= 500) {
            await atomic.commit();
            atomic = kv.atomic();
            batchCount = 0;
          }
        }
      }

      if (batchCount > 0) {
        await atomic.commit();
      }

      list.count = listCount;
    } catch (e) {
      console.error(`Lỗi tải blocklist từ "${list.name}" (${list.url}):`, e);
    }
  }

  await kv.set(["config", "blocklists_catalog"], catalog);
  await kv.set(["config", "total_blocked_count"], totalUniqueDomains);
  return totalUniqueDomains;
}