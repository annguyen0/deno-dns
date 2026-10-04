import dnsPacket from "dns-packet";
import {
  getConfig,
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

async function forwardToUpstream(rawQuery: Uint8Array): Promise<Response> {
  const config = await getConfig();
  const upstreams = config.upstreams.length > 0
    ? config.upstreams
    : ["https://1.1.1.1/dns-query", "https://dns.google/dns-query"];

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

export async function handleDNSQuery(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  let rawQuery: Uint8Array | null = null;

  if (req.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (dnsParam) rawQuery = decodeBase64UrlSafe(dnsParam);
    else {
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

  const clientIp = req.headers.get("x-forwarded-for") || "Edge";
  let domain = "";

  try {
    const query = dnsPacket.decode(rawQuery);
    const question = query.questions?.[0];

    if (question && question.name) {
      domain = question.name.toLowerCase().replace(/\.$/, "");

      // 1. Kiểm tra Whitelist
      if (await isWhitelisted(domain)) {
        await recordStat(domain, "WHITELISTED", clientIp);
        return await forwardToUpstream(rawQuery);
      }

      // 2. Kiểm tra Custom Rewrites (Local DNS)
      const customIp = await getRewriteIP(domain);
      if (customIp) {
        await recordStat(domain, "REWRITE", clientIp);
        const rewritePacket = dnsPacket.encode({
          type: "response",
          id: query.id,
          flags: dnsPacket.AUTHORITATIVE_ANSWER,
          questions: query.questions,
          answers: [{
            type: (question.type as "A" | "AAAA") || "A",
            name: question.name,
            ttl: 300,
            data: customIp,
          }],
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

  if (domain) await recordStat(domain, "ALLOWED", clientIp);
  return await forwardToUpstream(rawQuery);
}