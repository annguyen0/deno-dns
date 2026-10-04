// Counter per-isolate (in-memory) + flush gom roi ra Deno KV.
//
// Nghia (plan §3.2 + §7): "gan du" la du.
// - Moi query: tang delta local (0 KV op, ~0ns).
// - Flush gom delta: moi FLUSH_INTERVAL_MS hoac delta.total ≥ FLUSH_DELTA_THRESHOLD,
//   1 atomic().sum(1 commit) cho ca 3 khoa so. Flush rong (delta = 0) KHONG ghi KV
//   (idempotent).
// - SIGINT: flush truoc khi tung — giam mat so khi instance duoc evict graceful.
// - So "global" tren dashboard = tong KV + delta chua flush cua instance dang phuc vu;
//   dashboard cung hien thi thong so delta (localDelta) rieng.
//
// Log per-request: BO luu KV (nha NVN + privacy). Thay bang ring buffer 50 muc
// in-memory per-instance cho dashboard (loi ro: "cua instance nay, khong phai toan cuc").

export type QueryStatus = "ALLOWED" | "BLOCKED" | "WHITELISTED" | "REWRITE";

export interface LogEntry {
  time: string;
  domain: string;
  status: QueryStatus;
  clientIp: string;
}

export interface LocalDelta {
  total: number;
  blocked: number;
  allowed: number;
}

export const FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_DELTA_THRESHOLD = 10_000;
export const LOG_RING_SIZE = 50;

export class QueryCounters {
  #delta: LocalDelta = { total: 0, blocked: 0, allowed: 0 };
  #flushing: Promise<void> | null = null;
  #logs: LogEntry[] = [];
  #logHead = 0;
  #logCount = 0;
  #timer: ReturnType<typeof setInterval>;
  #kv: Deno.Kv;
  #threshold: number;

  constructor(
    kv: Deno.Kv,
    intervalMs = FLUSH_INTERVAL_MS,
    threshold = FLUSH_DELTA_THRESHOLD,
  ) {
    this.#kv = kv;
    this.#threshold = threshold;
    this.#timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    try {
      Deno.addSignalListener("SIGINT", () => {
        void this.flush();
      });
    } catch {
      // Moi truong khong ho tro signal (mot so runtime test) — bo qua
    }
  }

  /** Record mot query — sync, 0 KV op (hot path). */
  record(domain: string, status: QueryStatus, clientIp: string): void {
    this.#delta.total++;
    if (status === "BLOCKED") {
      this.#delta.blocked++;
    } else {
      this.#delta.allowed++;
    }
    this.#pushLog({
      time: new Date().toISOString(),
      domain,
      status,
      clientIp,
    });
    if (this.#delta.total >= this.#threshold) {
      void this.flush();
    }
  }

  #pushLog(entry: LogEntry): void {
    if (this.#logCount < LOG_RING_SIZE) {
      this.#logs[this.#logHead] = entry;
      this.#logHead = (this.#logHead + 1) % LOG_RING_SIZE;
      this.#logCount++;
    } else {
      this.#logs[this.#logHead] = entry;
      this.#logHead = (this.#logHead + 1) % LOG_RING_SIZE;
    }
  }

  /**
   * Gom delta dang ky vao KV bang atomic().sum (1 commit/3 khoa so).
   * Idempotent: delta = 0 → tra ve trong im, khong ghi. Coalesce: flush dang bay
   * → tra ve dong Promise, delta moi sẽ duoc flush lan tiep theo.
   */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    const d: LocalDelta = { ...this.#delta };
    this.#delta = { total: 0, blocked: 0, allowed: 0 };
    if (d.total === 0) return Promise.resolve();
    this.#flushing = (async () => {
      await this.#kv
        .atomic()
        .sum(["stats", "total"], BigInt(d.total))
        .sum(["stats", "blocked"], BigInt(d.blocked))
        .sum(["stats", "allowed"], BigInt(d.allowed))
        .commit();
    })().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  /** Delta chua flush cua instance nay (de dashboard hien thi + merge "global"). */
  localDelta(): LocalDelta {
    return { ...this.#delta };
  }

  /** Ring buffer log: 50 muc moi nhat, moi nhat truoc (giong thu cu cua dashboard). */
  getLogs(): LogEntry[] {
    if (this.#logCount === 0) return [];
    const out: LogEntry[] = [];
    for (let i = 0; i < this.#logCount; i++) {
      out.push(
        this.#logs[(this.#logHead - 1 - i + LOG_RING_SIZE * 2) % LOG_RING_SIZE],
      );
    }
    return out;
  }

  /** Test/shutdown: dung timer. */
  dispose(): void {
    clearInterval(this.#timer);
  }
}

let singleton: QueryCounters | null = null;

/** Khoi tao singleton (goi mot lan trong initStorage, sau openKv). */
export function initCounters(kv: Deno.Kv): QueryCounters {
  if (!singleton) {
    singleton = new QueryCounters(kv);
  }
  return singleton;
}

export function counters(): QueryCounters {
  if (!singleton) {
    throw new Error(
      "QueryCounters chua duoc khoi tao — goi initCounters() truoc",
    );
  }
  return singleton;
}

/** De test: danh singleton (dung timer cu, bo cho phan tich thu). */
export function resetCounters(): void {
  if (singleton) {
    singleton.dispose();
    singleton = null;
  }
}
