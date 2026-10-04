import { corsHeaders, handleDNSQuery } from "./src/dns.ts";
import {
  addWhitelist,
  getConfig,
  getRewrites,
  getStats,
  getWhitelist,
  initStorage,
  removeRewrite,
  removeWhitelist,
  saveConfig,
  setRewrite,
  syncBlocklists,
} from "./src/storage.ts";

await initStorage();

Deno.serve(async (req: Request, info: Deno.ServeHandlerInfo) => {
  const url = new URL(req.url);

  // Xử lý CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const jsonResponse = (data: unknown, status = 200) => {
    return Response.json(data, {
      status,
      headers: corsHeaders,
    });
  };

  // 1. DoH DNS Endpoint
  if (
    url.pathname === "/dns-query" ||
    url.pathname === "/dns-query/" ||
    (url.pathname === "/" &&
      (req.headers.get("content-type") === "application/dns-message" ||
        url.searchParams.has("dns") ||
        url.searchParams.has("name")))
  ) {
    return handleDNSQuery(req, info);
  }

  // 2. REST API Endpoints
  if (url.pathname === "/api/stats") {
    return jsonResponse(await getStats());
  }

  if (url.pathname === "/api/config") {
    if (req.method === "GET") return jsonResponse(await getConfig());
    if (req.method === "POST") {
      await saveConfig(await req.json());
      return jsonResponse({ success: true });
    }
  }

  if (url.pathname === "/api/whitelist") {
    if (req.method === "GET") return jsonResponse(await getWhitelist());
    if (req.method === "POST") {
      const { domain } = await req.json();
      await addWhitelist(domain);
      return jsonResponse({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      await removeWhitelist(domain);
      return jsonResponse({ success: true });
    }
  }

  if (url.pathname === "/api/rewrites") {
    if (req.method === "GET") return jsonResponse(await getRewrites());
    if (req.method === "POST") {
      const { domain, ip } = await req.json();
      await setRewrite(domain, ip);
      return jsonResponse({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      await removeRewrite(domain);
      return jsonResponse({ success: true });
    }
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const count = await syncBlocklists();
    return jsonResponse({ success: true, count });
  }

  // 3. Phục vụ Web UI Dashboard (Đọc từ tệp public/index.html)
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("Không tìm thấy tệp public/index.html", { status: 404 });
  }
});