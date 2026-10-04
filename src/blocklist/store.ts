// Blocklist/whitelist/rewrite in-memory per-isolate + snapshot co version trong Deno KV.
//
// Kien truc (plan §7): hot path DoH KHONG doc KV (0 op).
// - Blocklist: sync (admin /api/sync hoac Deno.cron) viêt chunk ["blocklist","v",{version},{i}]
//   (~50KB/chunk << gioi han 2MiB) roi ghi manifest ["blocklist","manifest"] CUOI CUNG.
//   Manifest la giao dien duy nhat: dung gioi gia giua sync (het chunk, chua co manifest)
//   thi moi instance van dung ban cu.
// - Moi isolate: 60s/mot lan doc manifest (1 read); version moi → tai N chunk (N read)
//   → build Set → swap tham chieu (atomic, khong mutates Set dang serve).
// - Gioi han 2 version trong KV: manifest giu danh sach {version, chunkCount} cu ↔ mới;
//   sau khi ghi manifest moi, xoa chunk cua version bi noai bo (tu loai — self-healing
//   neu lan truoc bi mat git).
//
// Whitelist/rewrite (quan ly bo admin, < 10k muc) van luu theo tung key trong KV
// (["whitelist", d], ["rewrites", d]) de giu API admin hien co, nhung tra cuu hot path
// di qua Set/Map in-memory duoc lam moi cung chu ky poll (doi instance bi admin sua
// tren instance kieu → instance khac tot noi ≤ 60s).

import type { BlocklistManifest } from "../types/index.ts";
import { REWRITES_PREFIX, WHITELIST_PREFIX } from "../kv/schema.ts";
import { buildDomainSet, chunkKey, MANIFEST_KEY } from "./snapshot.ts";
import { cleanDomain, suffixCandidates } from "./suffix.ts";

export class BlocklistStore {
  #blocked: Set<string> = new Set();
  #whitelist: Set<string> = new Set();
  #rewrites: Map<string, string> = new Map();
  #version: string | null = null;
  #inflight: Promise<boolean> | null = null;

  get version(): string | null {
    return this.#version;
  }

  get size(): number {
    return this.#blocked.size;
  }

  /** Set blocklist dang serve (read-only — cho test/debug; khong duoc mutate tru tiep). */
  get currentBlocked(): ReadonlySet<string> {
    return this.#blocked;
  }

  get whitelistSize(): number {
    return this.#whitelist.size;
  }

  get rewriteSize(): number {
    return this.#rewrites.size;
  }

  /** Cold start: tai manifest + rules (manifest khong ton tai → blocklist rong, van chay). */
  async init(kv: Deno.Kv): Promise<void> {
    await this.refresh(kv);
  }

  /** De test: ve trang thai rong (khong co snapshot, khong co rules). */
  reset(): void {
    this.#blocked = new Set<string>();
    this.#whitelist = new Set<string>();
    this.#rewrites = new Map<string, string>();
    this.#version = null;
    this.#inflight = null;
  }

  /**
   * Chu ky kiem tra (60s): version manifest moi → tai chunks + build Set + swap;
   * luon lam moi whitelist/rewrite in-memory. Loi giai: giu Set cu, log va lai lan sau.
   */
  async refresh(kv: Deno.Kv): Promise<void> {
    try {
      const entry = await kv.get<BlocklistManifest>(MANIFEST_KEY);
      if (entry.value && entry.value.version !== this.#version) {
        await this.loadVersion(kv, entry.value);
      }
      await this.refreshRules(kv);
    } catch (e) {
      console.error("BlocklistStore: loi refresh, giu ban hien tai:", e);
    }
  }

  /** Tai version chi dinh tu KV, build Set moi, swap tham chieu (atomic). */
  private async loadVersion(
    kv: Deno.Kv,
    manifest: BlocklistManifest,
  ): Promise<boolean> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = (async () => {
      try {
        const reads: Promise<Deno.KvEntryMaybe<string>>[] = [];
        for (let i = 0; i < manifest.versions[0].chunkCount; i++) {
          reads.push(kv.get<string>(chunkKey(manifest.version, i)));
        }
        const results = await Promise.all(reads);
        const values = results.map((r) => r.value);
        if (values.some((c) => c == null)) {
          console.error(
            `BlocklistStore: thua chunk cua version ${manifest.version} — giu ban cu`,
          );
          return false;
        }
        const chunks = values.filter((c): c is string => c != null);
        this.#blocked = buildDomainSet(chunks);
        this.#version = manifest.version;
        return true;
      } finally {
        this.#inflight = null;
      }
    })();
    return await this.#inflight;
  }

  /** Lam moi whitelist/rewrite tu KV (2 list op) → swap tham chieu. */
  async refreshRules(kv: Deno.Kv): Promise<void> {
    const whitelist = new Set<string>();
    for await (const entry of kv.list({ prefix: WHITELIST_PREFIX })) {
      whitelist.add(String(entry.key[1]));
    }
    const rewrites = new Map<string, string>();
    for await (const entry of kv.list({ prefix: REWRITES_PREFIX })) {
      if (typeof entry.value === "string") {
        rewrites.set(String(entry.key[1]), entry.value);
      }
    }
    this.#whitelist = whitelist;
    this.#rewrites = rewrites;
  }

  // Tra cuu sync (in-memory, 0 KV op) — storage.ts dong bao quanh Promise de
  // giu interface promise-compatible cho dns.ts.

  isWhitelisted(domain: string): boolean {
    for (const candidate of suffixCandidates(domain)) {
      if (this.#whitelist.has(candidate)) return true;
    }
    return false;
  }

  isBlocked(domain: string): boolean {
    for (const candidate of suffixCandidates(domain)) {
      if (this.#blocked.has(candidate)) return true;
    }
    return false;
  }

  /** Exact-match truong, sau do wildcard `*.suffix` (giong hinh hieu cu). */
  getRewriteIP(domain: string): string | null {
    const clean = cleanDomain(domain);
    if (!clean) return null;
    const exact = this.#rewrites.get(clean);
    if (exact) return exact;
    const parts = clean.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const wildcard = "*." + parts.slice(i).join(".");
      const hit = this.#rewrites.get(wildcard);
      if (hit) return hit;
    }
    return null;
  }

  stats() {
    return {
      version: this.#version,
      blockedDomains: this.#blocked.size,
      whitelistDomains: this.#whitelist.size,
      rewrites: this.#rewrites.size,
    };
  }
}

export const blocklistStore = new BlocklistStore();
