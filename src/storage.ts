const kv = await Deno.openKv();

export interface DNSConfig {
  upstreams: string[];
  blocklists: string[];
}

export interface CustomRewrite {
  domain: string;
  ip: string;
}

// Cởi tạo dữ liệu mặc định
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
}

// Thống kê & Logs
export async function recordStat(domain: string, status: "ALLOWED" | "BLOCKED" | "WHITELISTED" | "REWRITE", clientIp: string) {
  try {
    const isBlocked = status === "BLOCKED";
    const typeKey = isBlocked ? "blocked" : "allowed";

    await kv.atomic()
      .mutate({ type: "sum", key: ["stats", "total"], value: 1n })
      .mutate({ type: "sum", key: ["stats", typeKey], value: 1n })
      .commit();

    await kv.set(["logs", Date.now()], {
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString("vi-VN"),
      domain,
      status,
      clientIp,
    });
  } catch (e) {
    console.error("Lỗi ghi log:", e);
  }
}

export async function getStats() {
  const total = (await kv.get<bigint>(["stats", "total"])).value || 0n;
  const blocked = (await kv.get<bigint>(["stats", "blocked"])).value || 0n;
  const allowed = (await kv.get<bigint>(["stats", "allowed"])).value || 0n;
  const domainCount = (await kv.get<number>(["config", "total_blocked_count"])).value || 0;

  const logs = [];
  for await (const entry of kv.list({ prefix: ["logs"] }, { limit: 50, reverse: true })) {
    logs.push(entry.value);
  }

  return { total: Number(total), blocked: Number(blocked), allowed: Number(allowed), domainCount, logs };
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
  await kv.set(["whitelist", domain.toLowerCase().trim()], true);
}

export async function removeWhitelist(domain: string) {
  await kv.delete(["whitelist", domain.toLowerCase().trim()]);
}

export async function isWhitelisted(domain: string): Promise<boolean> {
  const res = await kv.get(["whitelist", domain.toLowerCase().trim()]);
  return !!res.value;
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
  await kv.set(["rewrites", domain.toLowerCase().trim()], ip.trim());
}

export async function removeRewrite(domain: string) {
  await kv.delete(["rewrites", domain.toLowerCase().trim()]);
}

export async function getRewriteIP(domain: string): Promise<string | null> {
  const res = await kv.get<string>(["rewrites", domain.toLowerCase().trim()]);
  return res.value || null;
}

// Blocklist Engine
export async function isBlocked(domain: string): Promise<boolean> {
  const res = await kv.get(["blocked_domains", domain.toLowerCase().trim()]);
  return !!res.value;
}

export async function syncBlocklists(): Promise<number> {
  const config = await getConfig();
  let totalDomains = 0;

  for (const url of config.blocklists) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[1] !== "localhost") {
          await kv.set(["blocked_domains", parts[1].toLowerCase()], true);
          totalDomains++;
        }
      }
    } catch (e) {
      console.error(`Lỗi tải blocklist từ ${url}:`, e);
    }
  }
  await kv.set(["config", "total_blocked_count"], totalDomains);
  return totalDomains;
}