// Tay chung duy nhat cua Deno KV cho toan app.
// - App: goi openKv() mot lan (default Deno Deploy / DENO_KV_PATH local).
// - Test: goi openKv(":memory:") de co KV rieng, khong danh danh vao file.
// - Khoa/mau schema: xem src/kv/schema.ts (MANIFEST_KEY, chunkKey, ...).
//
// NOTE: Deno 2.9.7 CLI KHONG tu doc DENO_KV_PATH trong Deno.openKv() (no chi
// tra ve location_data theo project) → minh doc env o day theo dung contract da ghi.

let handle: Deno.Kv | null = null;

function envKvPath(): string | undefined {
  try {
    return Deno.env.get("DENO_KV_PATH");
  } catch {
    // khong co quyen env (mot so runtime test) → dung default
    return undefined;
  }
}

export async function openKv(path?: string): Promise<Deno.Kv> {
  if (!handle) {
    handle = await Deno.openKv(path ?? envKvPath());
  }
  return handle;
}

export function getKv(): Deno.Kv {
  if (!handle) {
    throw new Error("KV chua duoc mo — goi openKv() truoc (initStorage)");
  }
  return handle;
}

export async function closeKv(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
}

/** De test: danh cache de mo KV moi (VD ":memory:") tai mo lan. */
export async function resetKv(): Promise<void> {
  await closeKv();
}
