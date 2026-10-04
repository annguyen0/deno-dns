// Admin API route handlers (plan §4.2 api/routes.ts).
//
// Phan cong: main.ts van quyen dispatch + CORS preflight + API rate-limit +
// authenticate; handler nay tra Response khi match va null khi khong match
// (main.ts tiep tuc dispatch → dashboard fallback — giu hanh vi cu nguyen).

import type { ClientInfo } from "../types/index.ts";
import {
  authenticateRequest,
  checkAdminPassword,
  createSession,
  deleteSession,
  getSessionIdFromRequest,
  isSetupNeeded,
  setAdminPassword,
} from "../auth/auth.ts";
import {
  checkLoginRateLimit,
  checkSyncRateLimit,
  recordLoginFailure,
  recordSyncTriggered,
  resetLoginFailure,
} from "../ratelimit/limiter.ts";
import {
  addCustomBlocklist,
  addCustomUpstream,
  addWhitelist,
  getBlocklistsCatalog,
  getRewrites,
  getUpstreamsCatalog,
  getWhitelist,
  removeBlocklist,
  removeRewrite,
  removeUpstream,
  removeWhitelist,
  setRewrite,
  syncBlocklists,
  toggleBlocklist,
  toggleUpstream,
} from "../storage.ts";
import { UnsafeUrlError } from "../ssrf/guard.ts";
import { asString, isValidPassword, requiredString } from "./validators.ts";

/** Context tu main.ts — du thong tin cho moi handler. */
export interface RouteContext {
  req: Request;
  url: URL;
  info: Deno.ServeHandlerInfo;
  client: ClientInfo;
  clientIp: string;
  jsonResponse: (
    data: unknown,
    status?: number,
    extraHeaders?: HeadersInit,
  ) => Response;
  jsonError: (message: string, status: number) => Response;
}

/**
 * Auth endpoints CONG KHAI (truoc authenticate): auth-status, setup, login, logout.
 * Rate limit da duoc main.ts ap dung truoc khi goi.
 */
export async function handlePublicAuthRoutes(
  ctx: RouteContext,
): Promise<Response | null> {
  const { req, url, clientIp, jsonResponse } = ctx;

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
    if (!isValidPassword(password)) {
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
    const isValid = await checkAdminPassword(asString(password));
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

  return null;
}

/**
 * Admin endpoints DA authenticate (main.ts kiem tra truoc): CRUD catalog,
 * whitelist, rewrites, sync, change-password.
 */
export async function handleAdminRoutes(
  ctx: RouteContext,
): Promise<Response | null> {
  const { req, url, jsonResponse, jsonError } = ctx;

  // Upstream Catalog
  if (url.pathname === "/api/upstreams") {
    if (req.method === "GET") {
      return jsonResponse(await getUpstreamsCatalog());
    }
    if (req.method === "POST") {
      const { name, url: upstreamUrl } = await req.json();
      try {
        const created = await addCustomUpstream(
          asString(name),
          asString(upstreamUrl),
        );
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
      await removeUpstream(asString(id));
      return jsonResponse({ success: true });
    }
  }

  if (url.pathname === "/api/upstreams/toggle" && req.method === "POST") {
    const { id, enabled } = await req.json();
    await toggleUpstream(asString(id), Boolean(enabled));
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
        const created = await addCustomBlocklist(
          asString(name),
          asString(listUrl),
        );
        return jsonResponse({ success: true, item: created });
      } catch (e) {
        return jsonError(
          e instanceof UnsafeUrlError ? e.message : "Không thể thêm blocklist",
          400,
        );
      }
    }
    if (req.method === "DELETE") {
      const { id } = await req.json();
      await removeBlocklist(asString(id));
      return jsonResponse({ success: true });
    }
  }

  if (url.pathname === "/api/blocklists/toggle" && req.method === "POST") {
    const { id, enabled } = await req.json();
    await toggleBlocklist(asString(id), Boolean(enabled));
    return jsonResponse({ success: true });
  }

  // Whitelist
  if (url.pathname === "/api/whitelist") {
    if (req.method === "GET") return jsonResponse(await getWhitelist());
    if (req.method === "POST") {
      const { domain } = await req.json();
      const field = requiredString(domain, "domain");
      if (!field.ok) return jsonError(field.error, 400);
      await addWhitelist(field.value);
      return jsonResponse({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      const field = requiredString(domain, "domain");
      if (!field.ok) return jsonError(field.error, 400);
      await removeWhitelist(field.value);
      return jsonResponse({ success: true });
    }
  }

  // Local DNS Rewrites
  if (url.pathname === "/api/rewrites") {
    if (req.method === "GET") return jsonResponse(await getRewrites());
    if (req.method === "POST") {
      const { domain, ip } = await req.json();
      const field = requiredString(domain, "domain");
      if (!field.ok) return jsonError(field.error, 400);
      const ipField = requiredString(ip, "ip");
      if (!ipField.ok) return jsonError(ipField.error, 400);
      await setRewrite(field.value, ipField.value);
      return jsonResponse({ success: true });
    }
    if (req.method === "DELETE") {
      const { domain } = await req.json();
      const field = requiredString(domain, "domain");
      if (!field.ok) return jsonError(field.error, 400);
      await removeRewrite(field.value);
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
    const isValid = await checkAdminPassword(asString(currentPassword));
    if (!isValid) {
      return jsonResponse({ error: "Mật khẩu hiện tại không đúng!" }, 400);
    }
    if (!isValidPassword(newPassword)) {
      return jsonResponse(
        { error: "Mật khẩu mới phải có ít nhất 6 ký tự!" },
        400,
      );
    }
    await setAdminPassword(newPassword.trim());
    return jsonResponse({ success: true });
  }

  return null;
}
