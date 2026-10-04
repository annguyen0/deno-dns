const kv = await Deno.openKv();

export interface DNSConfig {
  upstreams: string[];
  blocklists: string[];
}

export interface CustomRewrite {
  domain: string;
  ip: string;
}

// Khởi tạo dữ liệu mặc định
export async function initStorage() {
  const upstreams = await kv.get(["config", "upstreams"]);
  if (!upstreams.value) {
    await kv.set(["config", "upstreams"], [
      "https://1.1.1.1/dns-query",
      "https://dns.google/dns-query",
    ]);
  }

  const blocklists = await kv.get(["config", "blocklists"]);
  if (!blocklists.value) {
    await kv.set(["config", "blocklists"], [
      "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    ]);
  }

  // Khởi tạo và đồng bộ hóa các bộ đếm thống kê đảm bảo kiểu Deno.KvU64
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

// Config Upstreams & Blocklist URLs
export async function getConfig(): Promise<DNSConfig> {
  const upstreams = (await kv.get<string[]>(["config", "upstreams"])).value || [];
  const blocklists = (await kv.get<string[]>(["config", "blocklists"])).value || [];
  return { upstreams, blocklists };
}

export async function saveConfig(config: DNSConfig) {
  if (config.upstreams) await kv.set(["config", "upstreams"], config.upstreams);
  if (config.blocklists) await kv.set(["config", "blocklists"], config.blocklists);
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
  // Khớp chính xác
  const res = await kv.get<string>(["rewrites", clean]);
  if (res.value) return res.value;

  // Khớp wildcard (*.domain)
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

export async function syncBlocklists(): Promise<number> {
  const config = await getConfig();
  let totalDomains = 0;

  for (const url of config.blocklists) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const text = await response.text();
      let atomic = kv.atomic();
      let batchCount = 0;

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[1] !== "localhost") {
          const domain = parts[1].toLowerCase().trim().replace(/\.$/, "");
          if (domain) {
            atomic.set(["blocked_domains", domain], true);
            totalDomains++;
            batchCount++;
            if (batchCount >= 500) {
              await atomic.commit();
              atomic = kv.atomic();
              batchCount = 0;
            }
          }
        }
      }
      if (batchCount > 0) {
        await atomic.commit();
      }
    } catch (e) {
      console.error(`Lỗi tải blocklist từ ${url}:`, e);
    }
  }
  await kv.set(["config", "total_blocked_count"], totalDomains);
  return totalDomains;
}