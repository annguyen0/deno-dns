// Ring buffer log per-instance (plan §11 item #2: logs KHONG con ghi KV).
// 50 muc moi nhat, moi nhat truoc (giong thu cu cua dashboard).

import type { LogEntry } from "../types/index.ts";
import { LOG_RING_SIZE } from "./constants.ts";

export class LogRing {
  #entries: LogEntry[] = [];
  #head = 0;
  #count = 0;

  get size(): number {
    return this.#count;
  }

  push(entry: LogEntry): void {
    this.#entries[this.#head] = entry;
    this.#head = (this.#head + 1) % LOG_RING_SIZE;
    if (this.#count < LOG_RING_SIZE) this.#count++;
  }

  /** 50 muc moi nhat, moi nhat truoc. */
  toArray(): LogEntry[] {
    if (this.#count === 0) return [];
    const out: LogEntry[] = [];
    for (let i = 0; i < this.#count; i++) {
      out.push(
        this.#entries[(this.#head - 1 - i + LOG_RING_SIZE * 2) % LOG_RING_SIZE],
      );
    }
    return out;
  }

  clear(): void {
    this.#entries = [];
    this.#head = 0;
    this.#count = 0;
  }
}
