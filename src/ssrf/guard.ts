// Validation URL nguon external (custom blocklist / custom upstream) — chan SSRF
// (ARCH §9: "Abuse sync (SSRF)"). Admin authenticated + cooldown 180s la bien phap
// co suong; validation nay la tuyen bao mat thuc su:
// - Chi https:// (khong co file://, http://, gopher://...)
// - Chan hostname noi bo: localhost, *.local, *.internal
// - Chan IP literal trong range private/loopback/link-local (ket hop metadata
//   169.254.169.254 + 169.254.0.0/16)
// Gioi han: khong resolve hostname (DNS rebinding) — URL custom nen la host co
// ten domen cong khai (github raw, oisd.nl...). Nền tang Deno Deploy cung co the
// chan fetch vao range private (residual risk duoc ghi nhan).

import { isPrivateOrLoopbackIp, isValidIp } from "../clientip/trust.ts";
import { BLOCKED_HOST_SUFFIXES, BLOCKED_HOSTS } from "./constants.ts";

export class UnsafeUrlError extends Error {}

export function assertSafeFetchUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("URL không hợp lệ");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("Chỉ chấp nhận URL https://");
  }
  // URL.hostname cua IPv6 giu ngoac (VD "[fd12::1]") — strip truoc khi so sanh
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw new UnsafeUrlError("Hostname nội bộ không được phép");
  }
  if (isValidIp(host) && isPrivateOrLoopbackIp(host)) {
    throw new UnsafeUrlError("Địa chỉ IP nội bộ/metadata không được phép");
  }
  return url.toString();
}
