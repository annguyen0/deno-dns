import { assertEquals } from "@std/assert";
import {
  getClientInfo,
  isPrivateOrLoopbackIp,
  isValidIp,
  parsePlatformHeader,
} from "./trust.ts";

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example.com/dns-query", { headers });
}

function infoWithHost(host: string): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname: host, port: 12345 },
    completed: Promise.resolve(),
  };
}

Deno.test("clientip: isValidIp — IPv4/IPv6 hợp lệ và sai", () => {
  assertEquals(isValidIp("8.8.8.8"), true);
  assertEquals(isValidIp("203.0.113.7"), true);
  assertEquals(isValidIp("2001:db8::1"), true);
  assertEquals(isValidIp("999.1.1.1"), false);
  assertEquals(isValidIp("1.2.3"), false);
  assertEquals(isValidIp("not-an-ip"), false);
  assertEquals(isValidIp(""), false);
});

Deno.test("clientip: isPrivateOrLoopbackIp phân loại đúng", () => {
  assertEquals(isPrivateOrLoopbackIp("10.1.2.3"), true);
  assertEquals(isPrivateOrLoopbackIp("172.16.0.1"), true);
  assertEquals(isPrivateOrLoopbackIp("172.31.255.255"), true);
  assertEquals(isPrivateOrLoopbackIp("192.168.1.10"), true);
  assertEquals(isPrivateOrLoopbackIp("127.0.0.1"), true);
  assertEquals(isPrivateOrLoopbackIp("169.254.169.254"), true);
  assertEquals(isPrivateOrLoopbackIp("0.0.0.0"), true);
  assertEquals(isPrivateOrLoopbackIp("::1"), true);
  assertEquals(isPrivateOrLoopbackIp("fd12:3456::1"), true);
  assertEquals(isPrivateOrLoopbackIp("fe80::1"), true);
  assertEquals(isPrivateOrLoopbackIp("8.8.8.8"), false);
  assertEquals(isPrivateOrLoopbackIp("203.0.113.5"), false);
  assertEquals(isPrivateOrLoopbackIp("172.32.0.1"), false);
  assertEquals(isPrivateOrLoopbackIp("2606:4700:4700::1111"), false);
});

Deno.test("clientip: SPOOFING — client tự gửi cf-connecting-ip/x-real-ip/x-forwarded-for KHÔNG được tin", () => {
  const req = reqWithHeaders({
    "cf-connecting-ip": "66.66.66.66",
    "x-real-ip": "77.77.77.77",
    "x-forwarded-for": "88.88.88.88, 99.99.99.99",
    forwarded: "for=10.0.0.1",
  });

  // remoteAddr public → chi nhan remoteAddr, khong bao gio dung header client gui
  const got = getClientInfo(req, infoWithHost("1.2.3.4"));
  assertEquals(got.ip, "1.2.3.4");
  assertEquals(got.nodeRegion, null);

  // remoteAddr khac
  const got2 = getClientInfo(req, infoWithHost("203.0.113.9"));
  assertEquals(got2.ip, "203.0.113.9");
});

Deno.test("clientip: header nen tang hop le → dung theo header", () => {
  const req = reqWithHeaders({
    "x-denoforwarded-for": "8.8.4.4",
    "x-forwarded-for": "99.99.99.99", // phai bi loai bo
  });
  const info = getClientInfo(req, infoWithHost("1.2.3.4"));
  assertEquals(info.ip, "8.8.4.4");
  assertEquals(info.nodeRegion, null);
});

Deno.test("clientip: header nen dang 'ip, colo' → parse 2 doan", () => {
  const parsed = parsePlatformHeader("1.1.1.1, fra1");
  assertEquals(parsed.ip, "1.1.1.1");
  assertEquals(parsed.nodeRegion, "fra1");

  const req = reqWithHeaders({ "x-denoforwarded-for": "1.1.1.1, IAD" });
  const info = getClientInfo(req, infoWithHost("1.2.3.4"));
  assertEquals(info.ip, "1.1.1.1");
  assertEquals(info.nodeRegion, "iad"); // thuong hoa
});

Deno.test("clientip: IP public trong header nen + remoteAddr noi bo → van dung header nen", () => {
  const req = reqWithHeaders({ "x-denoforwarded-for": "203.0.113.7" });
  const info = getClientInfo(req, infoWithHost("10.0.0.5"));
  assertEquals(info.ip, "203.0.113.7");
});

Deno.test("clientip: IP private/loopback tu header nen → bo lua (an thuong)", () => {
  const req = reqWithHeaders({ "x-denoforwarded-for": "10.1.1.1" });
  const info = getClientInfo(req, infoWithHost("203.0.113.7"));
  assertEquals(info.ip, "203.0.113.7"); // fallback remoteAddr

  const req2 = reqWithHeaders({ "x-denoforwarded-for": "169.254.169.254" });
  const info2 = getClientInfo(req2, undefined);
  assertEquals(info2.ip, null); // khong co fallback → anonymous
});

Deno.test("clientip: khong co nen cung cap → ip = null (bucket 'unknown' chung)", () => {
  const info = getClientInfo(reqWithHeaders({}), undefined);
  assertEquals(info.ip, null);
  assertEquals(info.nodeRegion, null);
});

Deno.test("clientip: remoteAddr IPv6 hop le → dung", () => {
  const info = getClientInfo(reqWithHeaders({}), infoWithHost("2001:db8::42"));
  assertEquals(info.ip, "2001:db8::42");
});
