// Migration schema KV (plan §7 "Schema migration" + §5 Phase 1/Phase 5):
// 1. Xoa toan bo khoa legacy ["blocked_domains", ...] (code khong con doc/ghi —
//    blocklist da chuyen sang snapshot ["blocklist","manifest"] + ["blocklist","v",...]).
// 2. Kiem tra schema blocklist moi da ton tai (manifest + chunk) va in tom tat.
//
// Chay thu cong (manual — §11 item 1):
//   deno task migrate-kv
// Vi tri KV: mac dinh (local sqlite / DENO_KV_PATH neu set) — KHONG phai KV cua
// Deno Deploy khi chay local. Lenh nay chi DELETE legacy keys, khong dot pha du lieu khac.

import { closeKv, openKv } from "./index.ts";
import { LEGACY_BLOCKED_PREFIX, MANIFEST_KEY } from "./schema.ts";
import type { BlocklistManifest } from "../types/index.ts";

export interface MigrationResult {
  /** So legacy ["blocked_domains", ...] keys da xoa. */
  deleted: number;
  /** Manifest blocklist moi co ton tai khong. */
  manifestPresent: boolean;
  /** Cac version con co chunk trong KV. */
  chunkVersions: string[];
}

/** Xoa legacy blocked_domains/* + tong ket schema blocklist hien tai. */
export async function migrateKvSchema(kv: Deno.Kv): Promise<MigrationResult> {
  // 1. Xoa legacy keys (batch 500 delete/atomic — gioi han write/atomic cua KV)
  let deleted = 0;
  let batch = kv.atomic();
  let pending = 0;
  for await (const entry of kv.list({ prefix: LEGACY_BLOCKED_PREFIX })) {
    batch = batch.delete(entry.key);
    pending++;
    deleted++;
    if (pending >= 500) {
      await batch.commit();
      batch = kv.atomic();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();

  // 2. Tom tat schema blocklist moi
  const manifest = await kv.get<BlocklistManifest>(MANIFEST_KEY);
  const versions = new Set<string>();
  for await (const entry of kv.list({ prefix: ["blocklist", "v"] })) {
    if (typeof entry.key[2] === "string") versions.add(entry.key[2]);
  }

  return {
    deleted,
    manifestPresent: manifest.value !== null,
    chunkVersions: [...versions],
  };
}

if (import.meta.main) {
  const kv = await openKv();
  try {
    const r = await migrateKvSchema(kv);
    console.log(
      `migrate-kv: da xoa ${r.deleted} khoa legacy "blocked_domains/*"`,
    );
    console.log(
      `migrate-kv: blocklist manifest = ${
        r.manifestPresent ? "co" : "KHONG co (chua sync lan nao)"
      }; chunk versions = [${r.chunkVersions.join(", ") || "<none>"}]`,
    );
    if (r.deleted > 0) {
      console.log(
        "migrate-kv: OK — khong con khoa legacy; dung schema snapshot.",
      );
    } else {
      console.log("migrate-kv: OK — khong co khoa legacy nao de xoa.");
    }
  } finally {
    await closeKv();
  }
}
