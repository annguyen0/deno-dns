import { authenticateRequest } from "./src/auth/auth.ts";
import { corsHeaders, handleDNSQuery } from "./src/dns/pipeline.ts";
import { checkApiRateLimit } from "./src/ratelimit/limiter.ts";
import { getClientInfo } from "./src/clientip/trust.ts";
import { initStorage, syncBlocklists } from "./src/storage.ts";
import {
  handleAdminRoutes,
  handlePublicAuthRoutes,
  type RouteContext,
} from "./src/api/routes.ts";
import { handleDiagRoutes } from "./src/diag/diag.ts";

await initStorage();

// (Tuỳ chon, plan §7) Tong bo blocklist hang gio nen nen tang Deno Deploy
// (Deno.cron chi ton tai tren Deploy, khong co o Deno CLI local → guard runtime).
{
  const maybeCron = (
    Deno as unknown as {
      cron?: (expression: string, handler: () => Promise<void>) => void;
    }
  ).cron;
  if (typeof maybeCron === "function") {
    try {
      maybeCron.call(Deno, "5 * * * *", async () => {
        try {
          await syncBlocklists();
        } catch (e) {
          console.error("Deno.cron syncBlocklists loi (giu snapshot cu):", e);
        }
      });
      console.log("Đã bật đồng bộ blocklist tự động hàng giờ (Deno.cron)");
    } catch (e) {
      console.error("Không bật được Deno.cron (chỉ dùng /api/sync):", e);
    }
  }
}

Deno.serve(async (req: Request, info: Deno.ServeHandlerInfo) => {
  const url = new URL(req.url);

  // Xử lý CORS preflight cho mọi route
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // IP client DANG TIN: chi header nen tang / remoteAddr — khong doc header
  // client tu gan (cf-connecting-ip, x-real-ip, x-forwarded-for) (plan §5.2).
  // Bucket "unknown" chung cho nhung request khong xac dinh duoc IP — chan
  // vi ke tan xoay gia tri header de bo qua rate-limit (shared bucket).
  const client = getClientInfo(req, info);
  const clientIp = client.ip ?? "unknown";

  const jsonResponse = (
    data: unknown,
    status = 200,
    extraHeaders: HeadersInit = {},
  ) => {
    return Response.json(data, {
      status,
      headers: {
        ...corsHeaders,
        ...extraHeaders,
      },
    });
  };

  const jsonError = (message: string, status: number) =>
    jsonResponse({ error: message }, status);

  // 1. DoH DNS Endpoint (Public, có DDoS Rate Limiting riêng)
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

  // Rate Limiting chung cho tất cả các request API (120 req/phút)
  if (url.pathname.startsWith("/api/")) {
    const apiLimit = checkApiRateLimit(clientIp);
    if (!apiLimit.allowed) {
      return jsonResponse(
        { error: "Too Many Requests", retryAfter: apiLimit.retryAfter },
        429,
        { "Retry-After": String(apiLimit.retryAfter || 1) },
      );
    }
  }

  const ctx: RouteContext = {
    req,
    url,
    info,
    client,
    clientIp,
    jsonResponse,
    jsonError,
  };

  // 2. Authentication Endpoints (Public) — truoc authenticate
  const authRoute = await handlePublicAuthRoutes(ctx);
  if (authRoute) return authRoute;

  // 3. Protected Admin API Endpoints (Bắt buộc xác thực)
  if (url.pathname.startsWith("/api/")) {
    const isAuthenticated = await authenticateRequest(req);
    if (!isAuthenticated) {
      return jsonResponse({ error: "Unauthorized. Vui lòng đăng nhập!" }, 401);
    }

    const diagRoute = await handleDiagRoutes(ctx);
    if (diagRoute) return diagRoute;

    const adminRoute = await handleAdminRoutes(ctx);
    if (adminRoute) return adminRoute;
  }

  // 4. Phục vụ Web UI Dashboard (Đọc từ tệp public/index.html)
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("Không tìm thấy tệp public/index.html", {
      status: 404,
    });
  }
});
