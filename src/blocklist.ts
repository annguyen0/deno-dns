// Blocklist/whitelist/rewrite in-memory per-isolate + snapshot co version trong Deno KV.
//
// Kien truc (plan §7): hot path DoH KHÔNG doc KV (0 op).
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
// di qua Set/Map in-memory duoc lam mới cung chu ky poll (doi instance bi admin sua
// tren instance kieu → instance khac tot noi ≤ 60s).

export const MANIFEST_KEY: Deno.KvKey = ["blocklist", "manifest"];

export function chunkKey(version: string, index: number): Deno.KvKey {
  return ["blocklist", "v", version, index];
}

export interface VersionRef {
  version: string;
  chunkCount: number;
}

export interface BlocklistManifest {
  /** Version dang hieu luc (mới nhat). */
  version: string;
  /** Cac version con co chunk trong KV (mới nhat truoc), toc dai 2 — de doi instance
   *  chua kịp reload van tai duoc ban cu. */
  versions: VersionRef[];
  totalDomains: number;
  createdAt: number;
}

const TARGET_CHUNK_BYTES = 50 * 1024; // ~50KB/chunk — an toan xa gioi han 2MiB cua KV value
const MAX_KEPT_VERSIONS = 2;

export function cleanDomain(raw: string): string {
  return raw.toLowerCase().trim().replace(/\.$/, "");
}

/** Doc = "a.b.c" tra ra ["a.b.c", "b.c"] (giong hinh hieu cu: khong match label don). */
export function suffixCandidates(domain: string): string[] {
  const clean = cleanDomain(domain);
  if (!clean) return [];
  const parts = clean.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}

/**
 * Doc danh sach domain thanh cac chunk string ("domain\n"/dong), moi chunk ~≤ targetBytes.
 * Phan tung luon cat theo gioi han dong — moi chunk la tuyen hop phap.
 */
export function chunkDomains(
  domains: Iterable<string>,
  targetBytes = TARGET_CHUNK_BYTES,
): string[] {
  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const raw of domains) {
    const d = cleanDomain(raw);
    if (!d) continue;
    const line = d + "\n";
    if (size + line.length > targetBytes && size > 0) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += line;
    size += line.length;
  }
  if (size > 0) chunks.push(current);
  return chunks;
}

export function buildDomainSet(chunks: string[]): Set<string> {
  const set = new Set<string>();
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (line) set.add(line);
    }
  }
  return set;
}

/**
 * Ghi snapshot version moi: chunks → manifest (dong bo) → xoa chunk cua version cu nhat.
 * Tra ve manifest moi (va dong thoi la source of truth de instance hien tai lap lai).
 */
export async function writeBlocklistSnapshot(
  kv: Deno.Kv,
  domains: Set<string>,
  oldManifest: BlocklistManifest | null,
): Promise<BlocklistManifest> {
  const version = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const chunks = chunkDomains(domains);

  await Promise.all(chunks.map((c, i) => kv.set(chunkKey(version, i), c)));

  const versions: VersionRef[] = [
    { version, chunkCount: chunks.length },
    ...(oldManifest?.versions ?? []),
  ].slice(0, MAX_KEPT_VERSIONS);

  const manifest: BlocklistManifest = {
    version,
    versions,
    totalDomains: domains.size,
    createdAt: Date.now(),
  };
  await kv.set(MANIFEST_KEY, manifest);

  const kept = new Set(versions.map((v) => v.version));
  const staleRefs = (oldManifest?.versions ?? []).filter((v) =>
    !kept.has(v.version)
  );
  for (const ref of staleRefs) {
    await Promise.all(
      Array.from(
        { length: ref.chunkCount },
        (_, i) => kv.delete(chunkKey(ref.version, i)),
      ),
    );
  }
  return manifest;
}

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
   * luon lam mới whitelist/rewrite in-memory. Loi giai: giu Set cu, log va lai lan sau.
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
        const blocked = buildDomainSet(chunks);
        this.#blocked = blocked;
        this.#version = manifest.version;
        return true;
      } finally {
        this.#inflight = null;
      }
    })();
    return await this.#inflight;
  }

  /** Lam mới whitelist/rewrite tu KV (2 list op) → swap tham chieu. */
  async refreshRules(kv: Deno.Kv): Promise<void> {
    const whitelist = new Set<string>();
    for await (const entry of kv.list({ prefix: ["whitelist"] })) {
      whitelist.add(String(entry.key[1]));
    }
    const rewrites = new Map<string, string>();
    for await (const entry of kv.list({ prefix: ["rewrites"] })) {
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
