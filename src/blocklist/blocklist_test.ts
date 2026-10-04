import { assert, assertEquals } from "@std/assert";
import type { BlocklistManifest } from "../types/index.ts";
import {
  buildDomainSet,
  chunkDomains,
  chunkKey,
  MANIFEST_KEY,
  writeBlocklistSnapshot,
} from "./snapshot.ts";
import { BlocklistStore } from "./store.ts";

const TWO_MIB = 2 * 1024 * 1024;

function makeDomains(n: number, prefix = "d"): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) s.add(`${prefix}${i}.example.com`);
  return s;
}

Deno.test("blocklist: chunkDomains 10k — round-trip + chunk << 2MiB + cut theo dong", () => {
  const domains = makeDomains(10_000);
  const chunks = chunkDomains(domains);

  // 10k domain × ~18B ≈ 180KB / 50KB ≈ 4 chunk
  assert(
    chunks.length >= 3 && chunks.length <= 6,
    `10k domain phai cho ~4 chunk 50KB, co ${chunks.length}`,
  );
  for (const c of chunks) {
    const bytes = new TextEncoder().encode(c).length;
    assert(bytes < TWO_MIB, `chunk ${bytes}B phai < 2MiB`);
    assert(
      c.endsWith("\n"),
      "moi chunk phai ket thuc bang dong hoachan (tuong thich parse)",
    );
  }
  const rebuilt = buildDomainSet(chunks);
  assertEquals(rebuilt.size, domains.size);
  for (const d of domains) assert(rebuilt.has(d), `thieu ${d}`);
});

Deno.test("blocklist: 100k fixture — build Set dung va nhanh (< 2s)", () => {
  const domains = makeDomains(100_000, "big");
  const t0 = performance.now();
  const chunks = chunkDomains(domains);
  const set = buildDomainSet(chunks);
  const dt = performance.now() - t0;
  assertEquals(set.size, 100_000);
  assert(dt < 2_000, `100k trong ${dt.toFixed(0)}ms phai < 2s`);
  assert(
    chunks.length >= 35 && chunks.length <= 50,
    `100k ~ 40 chunk (plan §4), co ${chunks.length}`,
  );
});

Deno.test("blocklist: suffix-match a.b.c vs b.c — giong hinh hieu cu", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  const manifest = await writeBlocklistSnapshot(
    kv,
    new Set(["a.b.c", "b.c", "x.y"]),
    null,
  );
  await store.init(kv);
  assertEquals(store.version, manifest.version);

  assertEquals(await store.isBlocked("a.b.c"), true, "exact");
  assertEquals(await store.isBlocked("d.b.c"), true, "suffix b.c");
  assertEquals(await store.isBlocked("p.a.b.c"), true, "suffix a.b.c");
  assertEquals(await store.isBlocked("q.x.y"), true, "suffix x.y");
  assertEquals(
    await store.isBlocked("c"),
    false,
    "label don khong bao gio match",
  );
  assertEquals(await store.isBlocked("evil.net"), false);
});

Deno.test("blocklist: whitelist suffix + rewrite wildcard", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  await writeBlocklistSnapshot(kv, new Set([]), null);
  await kv.set(["whitelist", "good.com"], true);
  await kv.set(["rewrites", "*.home.local"], "192.168.1.100");
  await kv.set(["rewrites", "nas.exact.test"], "10.9.8.7");
  await store.init(kv);

  assertEquals(await store.isWhitelisted("good.com"), true);
  assertEquals(await store.isWhitelisted("mail.good.com"), true);
  assertEquals(await store.isWhitelisted("bmail.good.com"), true);
  assertEquals(await store.isWhitelisted("good.com.evil.net"), false);

  assertEquals(
    await store.getRewriteIP("nas.home.local"),
    "192.168.1.100",
    "wildcard",
  );
  assertEquals(await store.getRewriteIP("nas.exact.test"), "10.9.8.7", "exact");
  assertEquals(
    await store.getRewriteIP("home.local"),
    null,
    "wildcard khong match label cha",
  );
  assertEquals(await store.getRewriteIP("other.net"), null);
});

Deno.test("blocklist: manifest 2 version — giu 2 ben, xoa ben cu nhat", async () => {
  const kv = await Deno.openKv(":memory:");
  const s1 = new Set(["one.example", "two.example"]);
  const s2 = new Set(["three.example"]);
  const s3 = new Set(["four.example"]);

  const m1 = await writeBlocklistSnapshot(kv, s1, null);
  assertEquals(m1.versions.length, 1);

  const m2 = await writeBlocklistSnapshot(kv, s2, m1);
  assertEquals(m2.versions.length, 2, "giu 2 version");
  assertEquals(m2.versions[0].version, m2.version);
  // chunk ben v1 van con o (doi instance chua re-load)
  assertEquals(
    (await kv.get(chunkKey(m1.version, 0))).value,
    "one.example\ntwo.example\n",
  );

  const m3 = await writeBlocklistSnapshot(kv, s3, m2);
  assertEquals(m3.versions.length, 2, "van chi 2 version");
  assertEquals(
    m3.versions.map((v) => v.version),
    [m3.version, m2.version],
  );
  // chunk v1 da bi xoa, v2 van co
  assertEquals((await kv.get(chunkKey(m1.version, 0))).value, null);
  assertEquals(
    (await kv.get(chunkKey(m2.version, 0))).value,
    "three.example\n",
  );
  const manifestNow = (await kv.get<BlocklistManifest>(MANIFEST_KEY)).value;
  assertEquals(manifestNow?.version, m3.version);
  assertEquals(manifestNow?.totalDomains, 1);
});

Deno.test("blocklist: swap version atomic — Set cu khong bi mutate, Set moi duoc serve", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  const m1 = await writeBlocklistSnapshot(kv, new Set(["old.example"]), null);
  await store.init(kv);

  const oldSet = store.currentBlocked;
  assert(oldSet.has("old.example"));

  const m2 = await writeBlocklistSnapshot(
    kv,
    new Set(["old.example", "new.example"]),
    m1,
  );
  await store.refresh(kv);

  assertEquals(store.version, m2.version);
  assert(
    store.currentBlocked !== oldSet,
    "swap phai tao Set moi, khong mutate Set cu",
  );
  assert(
    oldSet.has("new.example") === false,
    "Set cu phai gan y khong bien doi",
  );
  assertEquals(await store.isBlocked("new.example"), true);
  assertEquals(await store.isBlocked("old.example"), true);
});

Deno.test("blocklist: sync bit mat git (co chunks, chua co manifest) — chi manifest la giao dien", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  const m1 = await writeBlocklistSnapshot(
    kv,
    new Set(["a.example", "b.example", "c.example"]),
    null,
  );
  await store.init(kv);
  assertEquals(store.version, m1.version);

  // Mo phong: sync v2 da ghi duoc chunks nhung bi mat TRUOC khi ghi manifest
  const v2 = "interrupted-v2";
  await kv.set(chunkKey(v2, 0), "d.example\n");
  await store.refresh(kv);
  assertEquals(store.version, m1.version, "manifest van chi v1 → van serve v1");
  assertEquals(await store.isBlocked("d.example"), false);

  // Hoan thanh: ghi manifest chi v2 → refresh tai v2
  await kv.set(
    MANIFEST_KEY,
    {
      version: v2,
      versions: [{ version: v2, chunkCount: 1 }, {
        version: m1.version,
        chunkCount: 1,
      }],
      totalDomains: 1,
      createdAt: Date.now(),
    } satisfies BlocklistManifest,
  );
  await store.refresh(kv);
  assertEquals(store.version, v2);
  assertEquals(await store.isBlocked("d.example"), true);
});

Deno.test("blocklist: chunk that bai khi tai (thieu key) — giu Set cu, khong crash", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  const m1 = await writeBlocklistSnapshot(
    kv,
    new Set(["a.example", "b.example"]),
    null,
  );
  await store.init(kv);

  // Mo phong: manifest chi v2 nhung chunks v2 mat (KV loi / bi xoa)
  const v2 = "missing-chunks-v2";
  await kv.set(
    MANIFEST_KEY,
    {
      version: v2,
      versions: [{ version: v2, chunkCount: 1 }],
      totalDomains: 1,
      createdAt: Date.now(),
    } satisfies BlocklistManifest,
  );
  await store.refresh(kv);
  assertEquals(store.version, m1.version, "tai v2 that bai → giu v1");
  assertEquals(await store.isBlocked("a.example"), true);
});

Deno.test("blocklist: cua ro ( chua sync ) — store rong, khong crash", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BlocklistStore();
  await store.init(kv);
  assertEquals(store.version, null);
  assertEquals(store.size, 0);
  assertEquals(await store.isBlocked("anything.example"), false);
  assertEquals(await store.getRewriteIP("x.y"), null);
});
