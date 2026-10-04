import { handleDNSQuery } from "./src/dns.ts";
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 1. DoH DNS Endpoint
  if (url.pathname === "/dns-query") {
    return handleDNSQuery(req);
  }

  // 2. REST API Endpoints
  if (url.pathname === "/api/stats") {
    return Response.json(await getStats());
  }

  if (url.pathname === "/api/config") {
    if (req.method === "GET") return Response.json(await getConfig());
    if (req.method === "POST") {
      await saveConfig(await req.json());
      return Response.json({ success: true });
    }
  }

  if (url.pathname === "/api/whitelist") {
    if (req.method === "GET") return Response.json(await getWhitelist());
    if (req.method === "POST") {
      const { domain } = await req.json();
      await addWhitelist(domain);
      return Response.json({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      await removeWhitelist(domain);
      return Response.json({ success: true });
    }
  }

  if (url.pathname === "/api/rewrites") {
    if (req.method === "GET") return Response.json(await getRewrites());
    if (req.method === "POST") {
      const { domain, ip } = await req.json();
      await setRewrite(domain, ip);
      return Response.json({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      await removeRewrite(domain);
      return Response.json({ success: true });
    }
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const count = await syncBlocklists();
    return Response.json({ success: true, count });
  }

  // 3. Phục vụ Web UI Dashboard (Đọc từ tệp public/index.html)
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("Không tìm thấy tệp public/index.html", { status: 444 });
  }
});