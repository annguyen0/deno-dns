import { assert, assertEquals } from "@std/assert";
import { openKv, resetKv } from "./kv.ts";
import {
  addCustomBlocklist,
  addWhitelist,
  getActiveUpstreamUrls,
  getRewriteIP,
  getStats,
  initStorage,
  isBlocked,
  isWhitelisted,
  setRewrite,
  syncBlocklists,
} from "./storage.ts";
import { counters, resetCounters } from "./counters.ts";
import { blocklistStore } from "./blocklist.ts";
import { upstreamCatalog } from "./upstreams.ts";
import { BlocklistManifest, MANIFEST_KEY } from "./blocklist.ts";

// Moi test file chay trong rieng 1 isolate (singleton an toan giua cac file),
// nhung cac test TRONG mot file chia se module state (kv cache, counters,
// blocklistStore, upstreamCatalog) → moi test phai reset + mo :memory: rieng.

async function freshEnv(): Promise<Deno.Kv> {
  await resetKv();
  resetCounters();
  blocklistStore.reset();
  upstreamCatalog.reset();
  const kv = await openKv(":memory:");
  await initStorage();
  return kv;
}

type StubHandler = (url: string) => string | number;

// stubFetch GOI MOT LAN, dung xong phai restore() TRUOC khi stub khac
function stubFetch(handler: StubHandler) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const out = handler(url);
    const res = typeof out === "number"
      ? new Response("err", { status: out })
      : new Response(out, { status: 200 });
    return Promise.resolve(res);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

Deno.test("storage: initStorage seed catalog + counters + poll loop", async () => {
  const kv = await freshEnv();

  // stats keys da seed
  const total = await kv.get<Deno.KvU64>(["stats", "total"]);
  assert(total.value instanceof Deno.KvU64);

  // catalog upstream da seed (16 muc mac dinh)
  const up = await kv.get<unknown[]>(["config", "upstreams_catalog"]);
  assert(Array.isArray(up.value) && up.value.length >= 16);

  // blocklist store chua sync → rong, hot path van chay duoc
  assertEquals(await isBlocked("anything.example"), false);

  // getActiveUpstreamUrls (cache) khong tra ra rong
  const urls = await getActiveUpstreamUrls(null);
  assert(urls.length >= 1);
});

Deno.test("storage: syncBlocklists — snapshot version moi thay the tron vien", async () => {
  const kv = await freshEnv();

  // Nguon custom de stub fetch dinh toc URL (default source tra "x.example")
  await addCustomBlocklist("Test One", "https://list-one.example/hosts");
  await addCustomBlocklist("Test Two", "https://list-two.example/hosts");

  const restore1 = stubFetch((url) => {
    if (url.includes("one")) {
      return "ads-one.example\n||tracker.one.com^\n0.0.0.0 hosts-one.example\n";
    }
    if (url.includes("two")) return "ads-two.example\n\n# comment\n";
    return "x.example\n";
  });
  try {
    const r1 = await syncBlocklists();
    assert(r1.count >= 4, `count=${r1.count}`);
    assert(r1.version);

    // hot path tra cuu in-memory (instance do da sync → co hieu luc ngay)
    assertEquals(await isBlocked("sub.ads-one.example"), true, "suffix match");
    assertEquals(
      await isBlocked("a.tracker.one.com"),
      true,
      "adblock rule parse",
    );
    assertEquals(
      await isBlocked("hosts-one.example"),
      true,
      "hosts format parse",
    );

    const m1 = (await kv.get<BlocklistManifest>(MANIFEST_KEY)).value;
    assert(m1, "manifest da ghi");

    // Lan 2: nguon "one" tra HTTP 500 → snapshot chi con nguon con lai
    restore1();
    const restore2 = stubFetch((url) => {
      if (url.includes("one")) return 500; // nguon "one" loi
      if (url.includes("two")) return "ads-two.example\n";
      return "x.example\n";
    });
    try {
      const r2 = await syncBlocklists();
      assert(r2.errors.some((e) => e.includes("500")));
      const m2 = (await kv.get<BlocklistManifest>(MANIFEST_KEY)).value;
      assert(m2 && m2.version !== m1.version, "version moi");
      assertEquals(m2!.versions.length, 2, "giu 2 version trong KV");
      // domain cua nguon loi da mat khoi snapshot (thay the tron vien)
      assertEquals(await isBlocked("sub.ads-one.example"), false);
      assertEquals(await isBlocked("a.tracker.one.com"), false);
    } finally {
      restore2();
    }
  } finally {
    restore1();
  }
});

Deno.test("storage: syncBlocklists — TAT CA nguon loi → giu snapshot cu, throw", async () => {
  const kv = await freshEnv();

  const restore = stubFetch(() => 500);
  let threw = false;
  try {
    await syncBlocklists();
  } catch {
    threw = true;
  } finally {
    restore();
  }
  assert(threw, "syncBlocklists phai throw khi tat ca nguon loi");
  const m = (await kv.get<BlocklistManifest>(MANIFEST_KEY)).value;
  assertEquals(m, null, "khong ghi manifest moi — giu trang thai cu");
});

Deno.test("storage: whitelist/rewrite CRUD → in-memory co hieu luc ngay", async () => {
  await freshEnv();
  await addWhitelist("ok.example");
  assertEquals(await isWhitelisted("mail.ok.example"), true);
  await setRewrite("nas.home", "192.168.0.10");
  assertEquals(await getRewriteIP("nas.home"), "192.168.0.10");
});

Deno.test("storage: getStats merge — tong KV + delta local + logs ring buffer", async () => {
  await freshEnv();
  counters().record("blocked.example", "BLOCKED", "1.2.3.4");
  counters().record("allowed.example", "ALLOWED", "5.6.7.8");

  const s = await getStats();
  assertEquals(s.total, 2, "merge delta (chua flush)");
  assertEquals(s.blocked, 1);
  assertEquals(s.allowed, 1);
  assertEquals(s.localDelta.total, 2);
  assertEquals(s.logs.length, 2);
  assertEquals(s.logs[0].domain, "allowed.example", "moi nhat truoc");
  assertEquals(s.logs[0].clientIp, "5.6.7.8");
  assertEquals(s.blocklist.blockedDomains, 0);

  await counters().flush();
  const s2 = await getStats();
  assertEquals(s2.total, 2, "sau flush: tong KV + delta 0");
  assertEquals(s2.localDelta.total, 0);
});
