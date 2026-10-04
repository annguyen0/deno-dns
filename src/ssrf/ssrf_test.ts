import { assertEquals, assertThrows } from "@std/assert";
import { assertSafeFetchUrl, UnsafeUrlError } from "./guard.ts";

Deno.test("ssrf: URL https hop le → giu nguyen", () => {
  assertEquals(
    assertSafeFetchUrl("https://raw.githubusercontent.com/x/y/master/hosts"),
    "https://raw.githubusercontent.com/x/y/master/hosts",
  );
});

Deno.test("ssrf: bo toc khong co https://", () => {
  for (
    const url of [
      "http://example.com/hosts",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com",
      "not a url",
    ]
  ) {
    assertThrows(() => assertSafeFetchUrl(url), `phai bo toc: ${url}`);
  }
});

Deno.test("ssrf: bo toc hostname noi bo", () => {
  for (
    const url of [
      "https://localhost/hosts",
      "https://evil.local/x",
      "https://svc.internal/x",
      "https://nas.lan/x",
      "https://metadata.google.internal/latest",
    ]
  ) {
    assertThrows(() => assertSafeFetchUrl(url), `phai bo toc: ${url}`);
  }
});

Deno.test("ssrf: bo toc IP literal private/loopback/metadata", () => {
  for (
    const url of [
      "https://10.0.0.5/hosts",
      "https://192.168.1.1/hosts",
      "https://172.16.5.5/hosts",
      "https://127.0.0.1/hosts",
      "https://169.254.169.254/latest/meta-data",
      "https://[fd12::1]/hosts",
    ]
  ) {
    assertThrows(() => assertSafeFetchUrl(url), `phai bo toc: ${url}`);
  }
});

Deno.test("ssrf: IP public literal duoc chap nhan (vi du CDN IP-anycast)", () => {
  assertEquals(
    assertSafeFetchUrl("https://1.1.1.1/dns-query"),
    "https://1.1.1.1/dns-query",
  );
});

Deno.test("ssrf: loi la UnsafeUrlError de main.ts map thanh 400", () => {
  assertThrows(() => assertSafeFetchUrl("ftp://x"), UnsafeUrlError);
});
