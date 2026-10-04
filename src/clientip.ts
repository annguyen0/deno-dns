// Tra cuu IP client + ma region/colo node tu nen tang Deno Deploy.
//
// NGUYEN TAC BAO MAT: chi tin header do nen tang chen sau TLS terminate tai edge.
// Cac header do client tu gan (cf-connecting-ip, x-real-ip, x-forwarded-for,
// forwarded) LUON BI BO LUA — khong doc, khong dung.
//
// TEN HEADER NEN TANG: chua duoc xac nhan chinh thuc tai thoi diem viet code
// (plan task 1: deploy /api/diag/headers, goi tu 2 vantage point US/EU).
// Mot khi verify xong, chi can sua PLATFORM_CLIENT_IP_HEADER + format parse o day.

import { isIP } from "node:net";

export const PLATFORM_CLIENT_IP_HEADER = "x-denoforwarded-for";

export interface ClientInfo {
  /** IP client dang tin (public, xac real duoc bo nen tang). null = khong xac dinh duoc. */
  ip: string | null;
  /** Ma region/colo cua node Deno dang xu ly (nen tang khong cung cap thi null). */
  nodeRegion: string | null;
}

export function isValidIp(value: string): boolean {
  return isIP(value.trim()) !== 0;
}

export function isPrivateOrLoopbackIp(value: string): boolean {
  const ip = value.trim();
  // IPv4
  if (ip.includes(".")) {
    const octets = ip.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)
    ) {
      return false;
    }
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (ket hop metadata 169.254.169.254)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  // IPv6
  if (ip === "::1") return true; // loopback
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA fc00::/7
  if (ip.startsWith("fe80")) return true; // link-local
  if (ip === "::" || ip.startsWith("::ffff:")) return true; // unspecified / IPv4-mapped
  return false;
}

export interface ParseResult {
  ip: string | null;
  nodeRegion: string | null;
}

/**
 * Parse gia tri header nen tang.
 * Gia dinh dinh dang hien tai: "clientIP" hoac "clientIP, <colo>" — VERIFY O TASK 1
 * roi chinh xa ham nay (moi noi parse dinh dang nen tang deu o day).
 */
export function parsePlatformHeader(raw: string | null): ParseResult {
  if (!raw) return { ip: null, nodeRegion: null };
  const parts = raw.split(",").map((p) => p.trim());
  const first = parts[0] ?? "";
  if (!first || !isValidIp(first)) return { ip: null, nodeRegion: null };
  const nodeRegion = parts.length > 1 && parts[1]
    ? parts[1].toLowerCase()
    : null;
  return { ip: first, nodeRegion };
}

/**
 * Tra ve { ip, nodeRegion } dang tin.
 * - Nho header nen tang: chi nhan IP public (IP private/loopback tu header nen tang
 *   duoc coi la an thuong → bo lua).
 * - Fallback: info.remoteAddr (edge/ineternal — su dung theo chat nghia degradation,
 *   de nghi rate-limit yeu hon khi nen tang khong cung cap header).
 */
export function getClientInfo(
  req: Request,
  info?: Deno.ServeHandlerInfo,
): ClientInfo {
  const parsed = parsePlatformHeader(
    req.headers.get(PLATFORM_CLIENT_IP_HEADER),
  );
  let ip: string | null = null;
  if (parsed.ip && !isPrivateOrLoopbackIp(parsed.ip)) {
    ip = parsed.ip;
  }

  if (!ip) {
    // remoteAddr la NetAddr|UnixAddr|VsockAddr — chi NetAddr co hostname
    const ra = info?.remoteAddr;
    const host = ra && "hostname" in ra ? ra.hostname?.trim() : undefined;
    if (host && isValidIp(host)) ip = host;
  }

  return { ip, nodeRegion: parsed.nodeRegion };
}
