import { assert, assertEquals } from "@std/assert";
import { checkApiRateLimit, checkDohRateLimit, LruMap } from "./ratelimit.ts";

Deno.test("LruMap: evict LRU khi het capacity", () => {
  const m = new LruMap<string, number>(3);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  assertEquals(m.get("a"), 1); // 'a' tro moi nhat
  m.set("d", 4); // 'b' (LRU) bi evict
  assertEquals(m.has("b"), false);
  assertEquals(m.has("a"), true);
  assertEquals(m.has("d"), true);
  assertEquals(m.size, 3);
});

Deno.test("LruMap: set key ton tai khong tang size, get khong co key → undefined", () => {
  const m = new LruMap<string, number>(2);
  m.set("a", 1);
  m.set("a", 2);
  assertEquals(m.size, 1);
  assertEquals(m.get("a"), 2);
  assertEquals(m.get("khong-co"), undefined);
  m.set("b", 1);
  m.set("c", 1); // 'a' evict
  assertEquals(m.has("a"), false);
});

Deno.test("LruMap: doi so luong lon (100k) — set/get nhan", () => {
  const m = new LruMap<string, number>(100_000);
  const t0 = performance.now();
  for (let i = 0; i < 100_000; i++) m.set(`ip-${i}`, i);
  for (let i = 0; i < 100_000; i += 1000) assertEquals(m.get(`ip-${i}`), i);
  assert(performance.now() - t0 < 2_000, "100k set+get phai nhanh");
});

type RlResult = ReturnType<typeof checkDohRateLimit>;

Deno.test("ratelimit: DoH token bucket — burst 120 roi 429 (IP kieu)", () => {
  const ip = "9.9.9.9-test";
  let allowed = 0;
  let last: RlResult = { allowed: true };
  for (let i = 0; i < 200 && last.allowed; i++) {
    last = checkDohRateLimit(ip);
    if (last.allowed) allowed++;
  }
  assertEquals(allowed, 120, "Burst 120 token (lan dau free + 119 token)");
  assertEquals(last.allowed, false);
  assert(last.retryAfter && last.retryAfter >= 1);
});

Deno.test("ratelimit: IP 'unknown' chung — chi 1 bucket (khong tu tao hang triu bucket gia)", () => {
  const a = checkDohRateLimit("unknown");
  const b = checkDohRateLimit("unknown");
  // Cung 1 bucket: so token con phai hon (1 + refill nho - 2)
  assertEquals(a.allowed, true);
  assertEquals(b.allowed, true);
  // Mo phong 120 lan de het bucket chung
  for (let i = 0; i < 120; i++) checkDohRateLimit("unknown");
  const c = checkDohRateLimit("unknown");
  assertEquals(
    c.allowed,
    false,
    "bucket 'unknown' dong cho tat ca request anonymous",
  );
});

Deno.test("ratelimit: API token bucket hoat dong", () => {
  const ip = "8.8.8.8-test";
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) {
    blocked = !checkApiRateLimit(ip).allowed;
  }
  assertEquals(blocked, true, "30 burst + refill → 40 lan phai het");
});
