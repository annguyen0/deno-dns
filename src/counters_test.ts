import { assertEquals } from "@std/assert";
import { LOG_RING_SIZE, QueryCounters } from "./counters.ts";

async function stats(kv: Deno.Kv) {
  const total = await kv.get<Deno.KvU64>(["stats", "total"]);
  const blocked = await kv.get<Deno.KvU64>(["stats", "blocked"]);
  const allowed = await kv.get<Deno.KvU64>(["stats", "allowed"]);
  return {
    total: Number(total.value?.value ?? 0n),
    blocked: Number(blocked.value?.value ?? 0n),
    allowed: Number(allowed.value?.value ?? 0n),
  };
}

Deno.test("counters: record tang delta local, 0 ghi KV", async () => {
  const kv = await Deno.openKv(":memory:");
  const c = new QueryCounters(kv, 3_600_000, 1_000_000); // khong tu flush trong test
  try {
    c.record("a.com", "BLOCKED", "1.2.3.4");
    c.record("b.com", "ALLOWED", "1.2.3.4");
    c.record("c.com", "WHITELISTED", "5.6.7.8");

    assertEquals(c.localDelta(), { total: 3, blocked: 1, allowed: 2 });
    const s = await stats(kv);
    assertEquals(s.total, 0, "chua flush → KV con 0 (hot path 0 op)");
  } finally {
    c.dispose();
  }
});

Deno.test("counters: flush gom delta — 1 atomic commit, 3 khoa so", async () => {
  const kv = await Deno.openKv(":memory:");
  const c = new QueryCounters(kv, 3_600_000, 1_000_000);
  try {
    for (let i = 0; i < 7; i++) {
      c.record(`d${i}.com`, i % 3 === 0 ? "BLOCKED" : "ALLOWED", "1.1.1.1");
    }
    await c.flush();

    const s = await stats(kv);
    assertEquals(s.total, 7);
    assertEquals(s.blocked, 3); // i=0,3,6
    assertEquals(s.allowed, 4);
    assertEquals(c.localDelta(), { total: 0, blocked: 0, allowed: 0 });
  } finally {
    c.dispose();
  }
});

Deno.test("counters: flush rong idempotent — KHONG ghi KV (versionstamp entry khong doi)", async () => {
  const kv = await Deno.openKv(":memory:");
  const c = new QueryCounters(kv, 3_600_000, 1_000_000);
  try {
    const before = await kv.get<Deno.KvU64>(["stats", "total"]);

    await c.flush(); // delta = 0
    await c.flush(); // lan nua

    const after = await kv.get<Deno.KvU64>(["stats", "total"]);
    assertEquals(
      after.versionstamp,
      before.versionstamp,
      "flush rong phai thinh im",
    );
  } finally {
    c.dispose();
  }
});

Deno.test("counters: threshold delta — de lai flush khi gan nguong", async () => {
  const kv = await Deno.openKv(":memory:");
  const c = new QueryCounters(kv, 3_600_000, 5); // threshold = 5
  try {
    for (let i = 0; i < 5; i++) c.record(`d${i}.com`, "ALLOWED", "1.1.1.1");
    // flush duoc huong den async (void) — cho event loop chay het
    await new Promise((r) => setTimeout(r, 50));
    assertEquals((await stats(kv)).total, 5);
  } finally {
    c.dispose();
  }
});

Deno.test("counters: coalesce — 2 flush dong thoi chi ghi mot lan", async () => {
  const kv = await Deno.openKv(":memory:");
  const c = new QueryCounters(kv, 3_600_000, 1_000_000);
  try {
    c.record("a.com", "ALLOWED", "1.1.1.1");
    const [p1, p2] = [c.flush(), c.flush()];
    await Promise.all([p1, p2]);
    assertEquals(
      (await stats(kv)).total,
      1,
      "delta duoc duyet mot lan, coalesce dung",
    );
  } finally {
    c.dispose();
  }
});

Deno.test("counters: ring buffer log — giu 50 moi nhat, thu tu moi nhat truoc", () => {
  // record() la sync va khong dung KV → co the truyen KV rui
  const c = new QueryCounters({} as unknown as Deno.Kv, 3_600_000, 1_000_000);
  try {
    for (let i = 0; i < LOG_RING_SIZE + 21; i++) {
      c.record(`dom${i}.com`, i % 2 === 0 ? "ALLOWED" : "BLOCKED", "1.1.1.1");
    }
    const logs = c.getLogs();
    assertEquals(logs.length, LOG_RING_SIZE);
    // Moi nhat truoc: i = 70 (chon le → i%2===0 → ALLOWED)
    assertEquals(logs[0].domain, `dom${LOG_RING_SIZE + 20}.com`);
    assertEquals(logs[0].status, "ALLOWED");
    // Cu nhat: i = 21 (chon le → BLOCKED)
    assertEquals(logs[LOG_RING_SIZE - 1].domain, "dom21.com");
    assertEquals(logs[LOG_RING_SIZE - 1].status, "BLOCKED");
  } finally {
    c.dispose();
  }
});

Deno.test("counters: getLogs rong → dong rong", () => {
  const c = new QueryCounters({} as unknown as Deno.Kv, 3_600_000, 1_000_000);
  try {
    assertEquals(c.getLogs(), []);
  } finally {
    c.dispose();
  }
});
