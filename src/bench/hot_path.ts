// Benchmark hot path policy lookup (plan §7 "Hot path 0 KV" + §10 NFR p50 < 20ms):
// do nhom 3 policy check (isWhitelisted → getRewriteIP → isBlocked) nhu dns/pipeline
// goi cho moi query — TOAN BO trong-memory, KHONG co KV.
//
// Chứng minh "0 KV op": doan do khong dung Deno.Kv (store doc Set/Map da load khi
// init); neu co bat ky KV access nao trong lookup thi code se khong chay duoc vi
// store khong nhan kv (van de dang ky API) — cac test cung chung minh dieu nay.
//
// Chay: deno task bench-hot-path
// Ky vong: p50 << 20ms (thuong dang µs) → exit 0; p50 >= 20ms → exit 1 (FAIL).

import { BlocklistStore } from "../blocklist/store.ts";
import { writeBlocklistSnapshot } from "../blocklist/snapshot.ts";

const N_DOMAINS = 50_000;
const N_WARMUP = 10_000;
const N_ITERATIONS = 100_000;
const P50_BUDGET_MS = 20; // §10 NFR: p50 self-response < 20ms (lookup chi la 1 thanh phan)

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

async function main(): Promise<void> {
  const kv = await Deno.openKv(":memory:");

  // Snapshot 50k domain + rules → load vao store
  const domains = new Set<string>();
  for (let i = 0; i < N_DOMAINS; i++) domains.add(`bench${i}.example.com`);
  await writeBlocklistSnapshot(kv, domains, null);
  await kv.set(["whitelist", "safe.example"], true);
  await kv.set(["rewrites", "nas.home.lan"], "192.168.0.10");

  const store = new BlocklistStore();
  await store.init(kv);
  await kv.close(); // khoa KV truoc khi do — lookup phai song duoc khong can KV

  // Mix truy van: block hit/miss, whitelist hit, rewrite hit/miss
  const probes = [
    "tracker.bench0.example.com", // block hit (suffix)
    "bench49999.example.com", // block hit (exact)
    "clean.example.org", // block miss
    "mail.safe.example", // whitelist hit (suffix)
    "nas.home.lan", // rewrite hit (exact)
    "unknown.tld", // miss toan bo
  ];

  // Warmup (JIT)
  for (let i = 0; i < N_WARMUP; i++) {
    const d = probes[i % probes.length];
    store.isWhitelisted(d);
    store.getRewriteIP(d);
    store.isBlocked(d);
  }

  // Do: moi lan = day du 3 policy check nhu pipeline
  const samples: number[] = new Array(N_ITERATIONS);
  for (let i = 0; i < N_ITERATIONS; i++) {
    const d = probes[i % probes.length];
    const t0 = performance.now();
    store.isWhitelisted(d);
    store.getRewriteIP(d);
    store.isBlocked(d);
    samples[i] = performance.now() - t0;
  }

  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const max = samples[samples.length - 1];

  const fmt = (ms: number) => `${(ms * 1000).toFixed(2)}µs`;
  console.log(
    "bench-hot-path: 3 policy checks/query (whitelist→rewrite→block), in-memory, 0 KV ops",
  );
  console.log(`  domains=${N_DOMAINS} iterations=${N_ITERATIONS}`);
  console.log(
    `  p50=${fmt(p50)}  p95=${fmt(p95)}  p99=${fmt(p99)}  max=${fmt(max)}`,
  );

  if (p50 >= P50_BUDGET_MS) {
    console.error(
      `FAIL: p50 ${p50.toFixed(3)}ms >= ${P50_BUDGET_MS}ms (§10 NFR)`,
    );
    Deno.exit(1);
  }
  console.log(
    `OK: p50 ${fmt(p50)} << ${P50_BUDGET_MS}ms — hot path 0 KV, trong muc NFR.`,
  );
}

if (import.meta.main) {
  await main();
}
