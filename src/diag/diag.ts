// Diagnostic endpoints: /api/diag/headers (dump header + env + remoteAddr de
// verify ten header nen tang — plan task 1) va /api/stats (counters + DDoS metrics).
// Chi admin (main.ts da authenticate truoc khi goi).

import { getRateLimitStats } from "../ratelimit/limiter.ts";
import { getStats } from "../storage.ts";
import type { RouteContext } from "../api/routes.ts";

export async function handleDiagRoutes(
  ctx: RouteContext,
): Promise<Response | null> {
  const { req, url, info, client, jsonResponse } = ctx;

  // Diag: dump header request + env DENO_* + remoteAddr. Chi admin, va chi giai
  // thong tin nhan hinh.
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

  return null;
}
