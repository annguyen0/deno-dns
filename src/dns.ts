import { Buffer } from "node:buffer";
import dnsPacket from "dns-packet";
import { checkDohRateLimit } from "./ratelimit.ts";
import {
  getActiveUpstreamUrls,
  getRewriteIP,
  isBlocked,
  isWhitelisted,
  recordStat,
} from "./storage.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

// Giới hạn kích thước gói tin DNS RFC chuẩn
const MAX_DNS_PACKET_BYTES = 4096;

function decodeBase64Url(str: string): Buffer | null {
  try {
    const s = str.trim().replace(/ /g, "+");
    let base64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

async function forwardToUpstream(rawQuery: Buffer): Promise<Response> {
  const upstreams = await getActiveUpstreamUrls();

  for (const upstream of upstreams) {
    try {
      const res = await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/dns-message",
          "Accept": "application/dns-message",
        },
        body: rawQuery,
        signal: AbortSignal.timeout(3000), // Timeout 3s tránh treo worker
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

export async function handleDNSQuery(
  req: Request,
  info?: Deno.ServeHandlerInfo
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const clientIp =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    info?.remoteAddr?.hostname ||
    "127.0.0.1";

  // --- DDoS & Rate Limiting Check (Token Bucket 60 req/s, Burst 120) ---
  const rateLimit = checkDohRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return new Response("Too Many DNS Requests", {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(rateLimit.retryAfter || 1),
      },
    });
  }

  const url = new URL(req.url);
  let rawQuery: Buffer | null = null;

  if (req.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (dnsParam) {
      rawQuery = decodeBase64Url(dnsParam);
    } else if (url.searchParams.has("name")) {
      const name = url.searchParams.get("name")!;
      const type = (url.searchParams.get("type") || "A").toUpperCase();
      try {
        rawQuery = Buffer.from(
          dnsPacket.encode({
            type: "query",
            id: Math.floor(Math.random() * 65535),
            flags: dnsPacket.RECURSION_DESIRED,
            questions: [{ type: type as "A" | "AAAA", name }],
          })
        );
      } catch {
        rawQuery = null;
      }
    } else {
      return new Response("DoH Server Active", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  } else if (req.method === "POST") {
    try {
      const arrayBuf = await req.arrayBuffer();
      if (arrayBuf.byteLength > 0) {
        rawQuery = Buffer.from(arrayBuf);
      }
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

  // --- Packet Size Sanity Check ---
  if (rawQuery.length > MAX_DNS_PACKET_BYTES) {
    return new Response("DNS Packet Too Large", {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let domain = "";
  let query: dnsPacket.Packet | null = null;
  let question: dnsPacket.Question | null = null;

  try {
    query = dnsPacket.decode(rawQuery);
    question = query.questions?.[0] ?? null;
    if (question && question.name) {
      domain = question.name.toLowerCase().replace(/\.$/, "");
    }
  } catch (err) {
    console.warn("Lỗi phân tích DNS packet:", err);
  }

  if (domain && query && question) {
    // 1. Kiểm tra Whitelist
    if (await isWhitelisted(domain)) {
      await recordStat(domain, "WHITELISTED", clientIp);
      return await forwardToUpstream(rawQuery);
    }

    // 2. Kiểm tra Custom Rewrites (Local DNS)
    const customIp = await getRewriteIP(domain);
    if (customIp) {
      await recordStat(domain, "REWRITE", clientIp);
      const isIpv6 = customIp.includes(":");
      const qType = question.type || "A";

      const answers = [];
      if ((qType === "A" && !isIpv6) || (qType === "AAAA" && isIpv6)) {
        answers.push({
          type: qType as "A" | "AAAA",
          name: question.name,
          ttl: 300,
          data: customIp,
        });
      }

      const rewritePacket = dnsPacket.encode({
        type: "response",
        id: query.id,
        flags: dnsPacket.AUTHORITATIVE_ANSWER | (query.flags & dnsPacket.RECURSION_DESIRED),
        questions: query.questions,
        answers,
      });

      return new Response(rewritePacket, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/dns-message",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // 3. Kiểm tra Blocklist
    if (await isBlocked(domain)) {
      await recordStat(domain, "BLOCKED", clientIp);
      const qType = question.type || "A";
      const blockedData = qType === "AAAA" ? "::" : "0.0.0.0";
      const blockedPacket = dnsPacket.encode({
        type: "response",
        id: query.id,
        flags: dnsPacket.AUTHORITATIVE_ANSWER | (query.flags & dnsPacket.RECURSION_DESIRED),
        questions: query.questions,
        answers: [{
          type: (qType as "A" | "AAAA") || "A",
          name: question.name,
          ttl: 300,
          data: blockedData,
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

  // 4. Cho phép và chuyển tiếp tới Upstream
  await recordStat(domain || "(unknown)", "ALLOWED", clientIp);

  const upstreamRes = await forwardToUpstream(rawQuery);

  // Nếu client là trình duyệt/JSON tool yêu cầu DNS JSON
  const acceptHeader = req.headers.get("accept") || "";
  if (
    acceptHeader.includes("application/dns-json") ||
    (url.searchParams.has("name") && !acceptHeader.includes("application/dns-message"))
  ) {
    try {
      const arrayBuf = await upstreamRes.arrayBuffer();
      const decodedRes = dnsPacket.decode(Buffer.from(arrayBuf));
      return Response.json(decodedRes, { headers: corsHeaders });
    } catch {
      // Fallback
    }
  }

  return upstreamRes;
}