// Tay chung duy nhat cua Deno KV cho toan app.
// - App: goi openKv() mot lan (default Deno Deploy / DENO_KV_PATH local).
// - Test: goi openKv(":memory:") de co KV rieng, khong dinh danh vao file.

let handle: Deno.Kv | null = null;

export async function openKv(path?: string): Promise<Deno.Kv> {
  if (!handle) {
    handle = await Deno.openKv(path);
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
