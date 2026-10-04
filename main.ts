import dnsPacket from "npm:dns-packet@^5.6.1";
import { decodeBase64Url } from "jsr:@std/encoding/base64url";
import { App } from "$fresh/server.ts";

const kv = await Deno.openKv();

// Khởi tạo cấu hình ban đầu
const upstreams = await kv.get(["config", "upstreams"]);
if (!upstreams.value) {
  await kv.set(["config", "upstreams"], ["https://1.1.1.1/dns-query", "https://dns.google/dns-query"]);
}
const blocklists = await kv.get(["config", "blocklists"]);
if (!blocklists.value) {
  await kv.set(["config", "blocklists"], ["https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"]);
}

// 1. Khởi tạo Fresh App và export
export const app = new App();

// 2. Đăng ký Middleware xử lý tất cả Request
app.use(async (ctx) => {
  const req = ctx.req;
  const url = new URL(req.url);

  // Endpoint DNS over HTTPS (DoH)
  if (url.pathname === "/dns-query") {
    return await handleDNSQuery(req);
  }

  // API Stats
  if (url.pathname === "/api/stats") {
    const total = (await kv.get<bigint>(["stats", "total"])).value || 0n;
    const blocked = (await kv.get<bigint>(["stats", "blocked"])).value || 0n;
    const allowed = (await kv.get<bigint>(["stats", "allowed"])).value || 0n;
    const domainCount = (await kv.get<number>(["config", "total_blocked_count"])).value || 0;

    const logs = [];
    for await (const entry of kv.list({ prefix: ["logs"] }, { limit: 20, reverse: true })) {
      logs.push(entry.value);
    }

    return Response.json({
      total: Number(total),
      blocked: Number(blocked),
      allowed: Number(allowed),
      domainCount,
      logs,
    });
  }

  // API Config
  if (url.pathname === "/api/config") {
    if (req.method === "GET") {
      const upstreams = (await kv.get(["config", "upstreams"])).value || [];
      const blocklists = (await kv.get(["config", "blocklists"])).value || [];
      return Response.json({ upstreams, blocklists });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (body.upstreams) await kv.set(["config", "upstreams"], body.upstreams);
      if (body.blocklists) await kv.set(["config", "blocklists"], body.blocklists);
      return Response.json({ success: true });
    }
  }

  // API Sync
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const count = await syncBlocklists();
    return Response.json({ success: true, count });
  }

  // Web Dashboard Trang chủ
  if (url.pathname === "/") {
    return new Response(getDashboardHTML(url.origin), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return ctx.next();
});

// Hàm hỗ trợ ghi nhận log
async function recordStat(domain: string, blocked: boolean, clientIp: string) {
  const typeKey = blocked ? "blocked" : "allowed";
  await kv.atomic()
    .mutate({ type: "sum", key: ["stats", "total"], value: 1n })
    .mutate({ type: "sum", key: ["stats", typeKey], value: 1n })
    .commit();

  await kv.set(["logs", Date.now()], {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString(),
    domain,
    blocked,
    clientIp,
  });
}

// Hàm hỗ trợ đồng bộ danh sách chặn
async function syncBlocklists() {
  const res = await kv.get<string[]>(["config", "blocklists"]);
  const urls = res.value || [];
  let totalDomains = 0;

  for (const url of urls) {
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
      console.error(e);
    }
  }
  await kv.set(["config", "total_blocked_count"], totalDomains);
  return totalDomains;
}

// Hàm xử lý DNS Query
async function handleDNSQuery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let rawQuery: Uint8Array | null = null;

  if (req.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (dnsParam) rawQuery = decodeBase64Url(dnsParam);
  } else if (req.method === "POST" && req.headers.get("content-type") === "application/dns-message") {
    rawQuery = new Uint8Array(await req.arrayBuffer());
  }

  if (!rawQuery) return new Response("Bad Request", { status: 400 });

  const query = dnsPacket.decode(rawQuery);
  const question = query.questions?.[0];
  if (!question) return new Response("Invalid Question", { status: 400 });

  const domain = question.name.toLowerCase().replace(/\.$/, "");
  const clientIp = req.headers.get("x-forwarded-for") || "Edge";

  const isBlocked = await kv.get(["blocked_domains", domain]);
  if (isBlocked.value) {
    await recordStat(domain, true, clientIp);
    const blockedPacket = dnsPacket.encode({
      type: "response",
      id: query.id,
      flags: dnsPacket.AUTHORITATIVE_ANSWER,
      questions: query.questions,
      answers: [{ type: question.type as "A" | "AAAA", name: question.name, ttl: 300, data: "0.0.0.0" }],
    });
    return new Response(blockedPacket, {
      headers: { "content-type": "application/dns-message" },
    });
  }

  await recordStat(domain, false, clientIp);
  const upstreams = (await kv.get<string[]>(["config", "upstreams"])).value || ["https://1.1.1.1/dns-query"];

  const upstreamRes = await fetch(upstreams[0], {
    method: "POST",
    headers: { "content-type": "application/dns-message", "accept": "application/dns-message" },
    body: rawQuery,
  });

  return new Response(await upstreamRes.arrayBuffer(), {
    headers: { "content-type": "application/dns-message" },
  });
}

function getDashboardHTML(origin: string) {
  return `<!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><title>DNS Dashboard</title></head>
  <body style="font-family:sans-serif; background:#0f172a; color:#fff; padding:20px;">
    <h1>⚡ Serverless DNS Dashboard</h1>
    <p>DoH URL: <code>${origin}/dns-query</code></p>
    <div id="stats">Đang tải thống kê...</div>
    <script>
      async function load() {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stats').innerHTML = \`
          <p>Tổng: <b>\${data.total}</b> | Đã chặn: <b>\${data.blocked}</b> | Cho phép: <b>\${data.allowed}</b></p>
          <p>Tên miền chặn: <b>\${data.domainCount.toLocaleString()}</b></p>
        \`;
      }
      load();
      setInterval(load, 3000);
    </script>
  </body>
  </html>`;
}

if (import.meta.main) {
  await app.listen();
}
