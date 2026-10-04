import {
  authenticateRequest,
  checkAdminPassword,
  createSession,
  deleteSession,
  getSessionIdFromRequest,
  isSetupNeeded,
  setAdminPassword,
} from "./src/auth.ts";
import { corsHeaders, handleDNSQuery } from "./src/dns.ts";
import {
  checkApiRateLimit,
  checkLoginRateLimit,
  checkSyncRateLimit,
  getRateLimitStats,
  recordLoginFailure,
  recordSyncTriggered,
  resetLoginFailure,
} from "./src/ratelimit.ts";
import { getClientInfo } from "./src/clientip.ts";
import {
  addCustomBlocklist,
  addCustomUpstream,
  addWhitelist,
  getBlocklistsCatalog,
  getRewrites,
  getStats,
  getUpstreamsCatalog,
  getWhitelist,
  initStorage,
  removeBlocklist,
  removeRewrite,
  removeUpstream,
  removeWhitelist,
  setRewrite,
  syncBlocklists,
  toggleBlocklist,
  toggleUpstream,
} from "./src/storage.ts";
import { UnsafeUrlError } from "./src/ssrf.ts";

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

  // 2. Authentication Endpoints (Public)
  if (url.pathname === "/api/auth-status" && req.method === "GET") {
    const authenticated = await authenticateRequest(req);
    const needsSetup = await isSetupNeeded();
    return jsonResponse({ authenticated, needsSetup });
  }

  if (url.pathname === "/api/setup" && req.method === "POST") {
    const needsSetup = await isSetupNeeded();
    if (!needsSetup) {
      return jsonResponse({ error: "Hệ thống đã có mật khẩu quản trị!" }, 400);
    }
    const { password } = await req.json();
    if (!password || password.trim().length < 6) {
      return jsonResponse({ error: "Mật khẩu phải có ít nhất 6 ký tự!" }, 400);
    }
    await setAdminPassword(password.trim());
    const session = await createSession();
    return jsonResponse(
      { success: true, token: session.sessionId },
      200,
      {
        "Set-Cookie":
          `doh_session=${session.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      },
    );
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const loginLimit = checkLoginRateLimit(clientIp);
    if (!loginLimit.allowed) {
      return jsonResponse(
        {
          error:
            `Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${loginLimit.retryAfter} giây!`,
        },
        429,
        { "Retry-After": String(loginLimit.retryAfter || 60) },
      );
    }

    const { password } = await req.json();
    const isValid = await checkAdminPassword(password || "");
    if (!isValid) {
      recordLoginFailure(clientIp);
      return jsonResponse({ error: "Mật khẩu không chính xác!" }, 401);
    }

    resetLoginFailure(clientIp);
    const session = await createSession();
    return jsonResponse(
      { success: true, token: session.sessionId },
      200,
      {
        "Set-Cookie":
          `doh_session=${session.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      },
    );
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    const sessionId = getSessionIdFromRequest(req);
    await deleteSession(sessionId);
    return jsonResponse(
      { success: true },
      200,
      {
        "Set-Cookie":
          `doh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
    );
  }

  // 3. Protected Admin API Endpoints (Bắt buộc xác thực)
  if (url.pathname.startsWith("/api/")) {
    const isAuthenticated = await authenticateRequest(req);
    if (!isAuthenticated) {
      return jsonResponse({ error: "Unauthorized. Vui lòng đăng nhập!" }, 401);
    }

    // Diag: dump header request + env DENO_* + remoteAddr de verify ten header
    // nen tang (plan task 1). Chi admin, va chi giai thong tin nhan hinh.
    if (url.pathname === "/api/diag/headers" && req.method === "GET") {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const DENO_ENV_KEYS = [
        "DENO_DEPLOY",
        "DENO_DEPLOY_ORG_ID",
        "DENO_DEPLOY_ORG_SLUG",
        "DENO_DEPLOY_APP_ID",
        "DENO_DEPLOY_APP_SLUG",
        "DENO_DEPLOY_BUILD_ID",
        "DENO_DEPLOYMENT_ID",
        "DENO_TIMELINE",
      ];
      const env: Record<string, string | null> = {};
      for (const key of DENO_ENV_KEYS) {
        env[key] = Deno.env.get(key) ?? null;
      }
      return jsonResponse({
        headers,
        env,
        remoteAddr: info?.remoteAddr ?? null,
        clientInfo: client,
      });
    }

    // Stats & DDoS Metrics
    if (url.pathname === "/api/stats") {
      const stats = await getStats();
      const ddosMetrics = getRateLimitStats();
      return jsonResponse({ ...stats, ddosMetrics });
    }

    // Upstream Catalog
    if (url.pathname === "/api/upstreams") {
      if (req.method === "GET") {
        return jsonResponse(await getUpstreamsCatalog());
      }
      if (req.method === "POST") {
        const { name, url: upstreamUrl } = await req.json();
        try {
          const created = await addCustomUpstream(name, upstreamUrl);
          return jsonResponse({ success: true, item: created });
        } catch (e) {
          return jsonError(
            e instanceof UnsafeUrlError ? e.message : "Không thể thêm upstream",
            400,
          );
        }
      }
      if (req.method === "DELETE") {
        const { id } = await req.json();
        await removeUpstream(id);
        return jsonResponse({ success: true });
      }
    }

    if (url.pathname === "/api/upstreams/toggle" && req.method === "POST") {
      const { id, enabled } = await req.json();
      await toggleUpstream(id, Boolean(enabled));
      return jsonResponse({ success: true });
    }

    // Blocklist Catalog
    if (url.pathname === "/api/blocklists") {
      if (req.method === "GET") {
        return jsonResponse(await getBlocklistsCatalog());
      }
      if (req.method === "POST") {
        const { name, url: listUrl } = await req.json();
        try {
          const created = await addCustomBlocklist(name, listUrl);
          return jsonResponse({ success: true, item: created });
        } catch (e) {
          return jsonError(
            e instanceof UnsafeUrlError
              ? e.message
              : "Không thể thêm blocklist",
            400,
          );
        }
      }
      if (req.method === "DELETE") {
        const { id } = await req.json();
        await removeBlocklist(id);
        return jsonResponse({ success: true });
      }
    }

    if (url.pathname === "/api/blocklists/toggle" && req.method === "POST") {
      const { id, enabled } = await req.json();
      await toggleBlocklist(id, Boolean(enabled));
      return jsonResponse({ success: true });
    }

    // Whitelist
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

    // Local DNS Rewrites
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

    // Blocklist Sync (Có Rate Limiting Cooldown 3 phút)
    // Semantics moi: snapshot version moi thay the tron vien (plan §7)
    if (url.pathname === "/api/sync" && req.method === "POST") {
      const syncLimit = checkSyncRateLimit();
      if (!syncLimit.allowed) {
        return jsonResponse(
          {
            error:
              `Đang trong thời gian chờ giãn cách đồng bộ. Vui lòng thử lại sau ${syncLimit.retryAfter} giây!`,
          },
          429,
          { "Retry-After": String(syncLimit.retryAfter || 60) },
        );
      }
      recordSyncTriggered();
      try {
        const { count, version, errors } = await syncBlocklists();
        return jsonResponse({ success: true, count, version, errors });
      } catch (e) {
        return jsonError(
          e instanceof Error ? e.message : "Lỗi đồng bộ blocklists",
          502,
        );
      }
    }

    // Change Admin Password
    if (url.pathname === "/api/change-password" && req.method === "POST") {
      const { currentPassword, newPassword } = await req.json();
      const isValid = await checkAdminPassword(currentPassword || "");
      if (!isValid) {
        return jsonResponse({ error: "Mật khẩu hiện tại không đúng!" }, 400);
      }
      if (!newPassword || newPassword.trim().length < 6) {
        return jsonResponse(
          { error: "Mật khẩu mới phải có ít nhất 6 ký tự!" },
          400,
        );
      }
      await setAdminPassword(newPassword.trim());
      return jsonResponse({ success: true });
    }
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
