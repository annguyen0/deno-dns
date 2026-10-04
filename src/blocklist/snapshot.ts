// Snapshot blocklist MVCC: chunk ghi truoc, manifest ghi CUOI cung la giao dien duy nhat.
// Khoa/mau: src/kv/schema.ts (MANIFEST_KEY, chunkKey) — tai day chi re-export cho
// tien loi nguoi goi blocklist.

import type { BlocklistManifest, VersionRef } from "../types/index.ts";
import { chunkKey, MANIFEST_KEY } from "../kv/schema.ts";
import { cleanDomain } from "./suffix.ts";

export { chunkKey, MANIFEST_KEY };
export type { BlocklistManifest, VersionRef };

const TARGET_CHUNK_BYTES = 50 * 1024; // ~50KB/chunk — an toan xa gioi han 2MiB cua KV value
const MAX_KEPT_VERSIONS = 2;

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
