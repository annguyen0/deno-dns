// Chinh sach ung xu cho DNS response: CORS + forward len upstream (ADR-3).
// Tach rieng pipeline.ts (route handling) vs policies.ts (CORS, forward) theo plan §4.2.

import { Buffer } from "node:buffer";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

// Forward tới upstream theo thuan tu (ADR-3). KHONG chuyen tiep header client gui
// (XFF/X-Real-IP) — chi append x-forwarded-for duy nhat tu IP dang tin nen tang.
export async function forwardToUpstream(
  rawQuery: Buffer,
  upstreams: string[],
  trustedClientIp: string | null,
): Promise<Response> {
  const xffHeader: string | null = trustedClientIp ? trustedClientIp : null;

  for (const upstream of upstreams) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/dns-message",
        "Accept": "application/dns-message",
      };
      if (xffHeader) headers["x-forwarded-for"] = xffHeader;

      const res = await fetch(upstream, {
        method: "POST",
        headers,
        // View dung kich cho byteLength (khong lay Buffer raw — Buffer co the
        // chung pool alloc lon hon; cast ArrayBuffer vi TS typed-array generics)
        body: new Uint8Array(
          rawQuery.buffer as ArrayBuffer,
          rawQuery.byteOffset,
          rawQuery.byteLength,
        ),
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

  return new Response("Upstream DNS Error", {
    status: 502,
    headers: corsHeaders,
  });
}
