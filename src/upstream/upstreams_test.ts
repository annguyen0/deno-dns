import { assertEquals } from "@std/assert";
import { UpstreamItem } from "../types/index.ts";
import { UpstreamCatalogCache } from "./catalog.ts";

const CATALOG: UpstreamItem[] = [
  {
    id: "cloudflare",
    name: "CF",
    url: "https://1.1.1.1/dns-query",
    description: "",
    tag: "speed",
    tagLabel: "",
    enabled: true,
  },
  {
    id: "google",
    name: "Google",
    url: "https://dns.google/dns-query",
    description: "",
    tag: "speed",
    tagLabel: "",
    enabled: true,
  },
  {
    id: "dns4eu",
    name: "DNS4EU",
    url: "https://protective.joindns4.eu/dns-query",
    description: "",
    tag: "security",
    tagLabel: "",
    enabled: true,
  },
  {
    id: "cleanbrowsing",
    name: "CB",
    url: "https://doh.cleanbrowsing.org/doh/family-filter/",
    description: "",
    tag: "family",
    tagLabel: "",
    enabled: false,
  },
  {
    id: "opendns",
    name: "OD",
    url: "https://doh.opendns.com/dns-query",
    description: "",
    tag: "speed",
    tagLabel: "",
    enabled: true,
  },
];

async function seededCache(): Promise<UpstreamCatalogCache> {
  const kv = await Deno.openKv(":memory:");
  await kv.set(["config", "upstreams_catalog"], CATALOG);
  const cache = new UpstreamCatalogCache();
  await cache.refresh(kv);
  return cache;
}

Deno.test("upstreams: khong biet region → giu thu tu catalog (fallback default)", async () => {
  const cache = await seededCache();
  assertEquals(cache.getActiveUpstreamUrls(null), [
    "https://1.1.1.1/dns-query",
    "https://dns.google/dns-query",
    "https://protective.joindns4.eu/dns-query",
    "https://doh.opendns.com/dns-query",
  ]);
  assertEquals(
    cache.getActiveUpstreamUrls("asia"),
    cache.getActiveUpstreamUrls(null),
  );
});

Deno.test("upstreams: region eu → uu tien dns4eu + cleanbrowsing (neu bat)", async () => {
  const cache = await seededCache();
  const eu = cache.getActiveUpstreamUrls("eu");
  assertEquals(eu[0], "https://protective.joindns4.eu/dns-query");
  // cleanbrowsing dang tat → khong xuat hien, van giu ca 4 upstream
  assertEquals(eu, [
    "https://protective.joindns4.eu/dns-query",
    "https://1.1.1.1/dns-query",
    "https://dns.google/dns-query",
    "https://doh.opendns.com/dns-query",
  ]);
});

Deno.test("upstreams: region us → uu tien cloudflare → google", async () => {
  const cache = await seededCache();
  const us = cache.getActiveUpstreamUrls("us");
  assertEquals(us.slice(0, 2), [
    "https://1.1.1.1/dns-query",
    "https://dns.google/dns-query",
  ]);
});

Deno.test("upstreams: catalog rong / het disable → fallback 2 upstream", () => {
  const cache = new UpstreamCatalogCache();
  assertEquals(cache.getActiveUpstreamUrls("eu"), [
    "https://1.1.1.1/dns-query",
    "https://dns.google/dns-query",
  ]);
});

Deno.test("upstreams: refresh lam moi tu KV, loi giu cu", async () => {
  const kv = await Deno.openKv(":memory:");
  await kv.set(["config", "upstreams_catalog"], CATALOG);
  const cache = new UpstreamCatalogCache();
  await cache.refresh(kv);
  assertEquals(cache.size, 5);

  const updated = CATALOG.map((u) =>
    u.id === "cloudflare" ? { ...u, enabled: false } : u
  );
  await kv.set(["config", "upstreams_catalog"], updated);
  await cache.refresh(kv);
  assertEquals(cache.getActiveUpstreamUrls(null).length, 3);

  // Cap nhat lap tuc (admin CRUD tren cung instance)
  cache.setItems(CATALOG);
  assertEquals(cache.getActiveUpstreamUrls(null).length, 4);
});
