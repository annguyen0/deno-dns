import dnsPacket from "dns-packet";

// Headers CORS bắt buộc cho trình duyệt
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const kv = await Deno.openKv();

// Giải mã Base64URL an toàn chuẩn RFC 8484
function decodeBase64UrlSafe(str: string): Uint8Array | null {
  try {
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    const binStr = atob(base64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Ghi log & thống kê truy vấn
async function recordStat(domain: string, blocked: boolean, clientIp: string) {
  try {
    const typeKey = blocked ? "blocked" : "allowed";
    await kv.atomic()
      .mutate({ type: "sum", key: ["stats", "total"], value: 1n })
      .mutate({ type: "sum", key: ["stats", typeKey], value: 1n })
      .commit();

    await kv.set(["logs", Date.now()], {
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString("vi-VN"),
      domain,
      blocked,
      clientIp,
    });
  } catch (e) {
    console.error("Lỗi ghi log:", e);
  }
}

// Chuyển tiếp gói tin DNS thô tới Upstream DoH (Failover tự động)
async function forwardToUpstream(rawQuery: Uint8Array): Promise<Response> {
  const upstreams = [
    "https://1.1.1.1/dns-query",
    "https://dns.google/dns-query",
    "https://dns.quad9.net/dns-query",
  ];

  for (const upstream of upstreams) {
    try {
      const res = await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/dns-message",
          "Accept": "application/dns-message",
        },
        body: rawQuery,
      });

      if (res.ok) {
        const body = await res.arrayBuffer();
        return new Response(body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/dns-message",
            "Cache-Control": "public, max-age=300",
          },
        });
      }
    } catch {
      continue;
    }
  }

  return new Response("Upstream DNS Error", { status: 502, headers: corsHeaders });
}

// Xử lý DoH Server
async function handleDNSQuery(req: Request): Promise<Response> {
  // 1. Phản hồi HTTP OPTIONS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  let rawQuery: Uint8Array | null = null;

  if (req.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (dnsParam) {
      rawQuery = decodeBase64UrlSafe(dnsParam);
    } else {
      // Phản hồi 200 OK cho các truy vấn Probe GET Ping không kèm tham số từ trình duyệt
      return new Response("DoH Server Active", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  } else if (req.method === "POST") {
    try {
      rawQuery = new Uint8Array(await req.arrayBuffer());
    } catch {
      rawQuery = null;
    }
  }

  if (!rawQuery || rawQuery.length === 0) {
    return new Response("DoH Server Active", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 2. Thử Parse gói tin để kiểm tra Blocklist
  let domain = "";
  try {
    const query = dnsPacket.decode(rawQuery);
    const question = query.questions?.[0];
    if (question && question.name) {
      domain = question.name.toLowerCase().replace(/\.$/, "");
      const isBlocked = await kv.get(["blocked_domains", domain]);

      if (isBlocked.value) {
        const clientIp = req.headers.get("x-forwarded-for") || "Edge";
        await recordStat(domain, true, clientIp);

        const blockedPacket = dnsPacket.encode({
          type: "response",
          id: query.id,
          flags: dnsPacket.AUTHORITATIVE_ANSWER,
          questions: query.questions,
          answers: [{
            type: (question.type as "A" | "AAAA") || "A",
            name: question.name,
            ttl: 300,
            data: "0.0.0.0",
          }],
        });

        return new Response(blockedPacket, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/dns-message",
            "Cache-Control": "public, max-age=300",
          },
        });
      }
    }
  } catch {
    // Nếu gói tin probe nâng cao không parse được bằng dns-packet, passthrough thẳng lên Upstream
  }

  // 3. Nếu không bị chặn (hoặc là gói tin probe thô), chuyển tiếp lên Upstream
  const clientIp = req.headers.get("x-forwarded-for") || "Edge";
  if (domain) await recordStat(domain, false, clientIp);

  return await forwardToUpstream(rawQuery);
}

// Server chính vừa phục vụ Web UI vừa phục vụ DoH Endpoint
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/dns-query") {
    return handleDNSQuery(req);
  }

  if (url.pathname === "/api/stats") {
    const total = (await kv.get<bigint>(["stats", "total"])).value || 0n;
    const blocked = (await kv.get<bigint>(["stats", "blocked"])).value || 0n;
    const allowed = (await kv.get<bigint>(["stats", "allowed"])).value || 0n;

    const logs = [];
    for await (const entry of kv.list({ prefix: ["logs"] }, { limit: 20, reverse: true })) {
      logs.push(entry.value);
    }

    return Response.json({
      total: Number(total),
      blocked: Number(blocked),
      allowed: Number(allowed),
      logs,
    });
  }

  return new Response(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Serverless DoH DNS Status</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; text-align: center; }
    .card { background: #1e293b; max-width: 600px; margin: 40px auto; padding: 24px; border-radius: 12px; border: 1px solid #334155; }
    code { background: #0f172a; padding: 6px 12px; border-radius: 6px; color: #38bdf8; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h2>⚡ Serverless DoH DNS Running</h2>
    <p>DoH Endpoint của bạn:</p>
    <p><code>${url.origin}/dns-query</code></p>
  </div>
</body>
</html>
  `, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});