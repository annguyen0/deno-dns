// Catalog Admin (nguon du lieu mac dinh) — UpstreamItem + DEFAULT_UPSTREAMS +
// DEFAULT_BLOCKLISTS + UpstreamCatalogCache in-memory (tra cuu hot path 0 KV).
//
// - Catalog luu trong KV ["config","upstreams_catalog"] (source of truth, admin CRUD).
// - Moi isolate: lam moi cache tu KV khi init + moi chu ky poll (60s, chung voi
//   blocklist poll) + cap nhat lap tuc sau moi admin CRUD o instance do.
// - Giao dien UpstreamItem/BlocklistItem: src/types/index.ts (shared).
// - Logic chon upstream theo region: src/upstream/selector.ts.
// - upstream_dns_list.json (goc repo, 39KB) la catalog TINH thu cong — khong duoc
//   import tu code; neu can bulk import thi dua vao day mot lan (plan §11 item 4).

import type { BlocklistItem, UpstreamItem } from "../types/index.ts";
import { CONFIG_KEYS } from "../kv/schema.ts";
import { selectUpstreamUrls } from "./selector.ts";

export const DEFAULT_UPSTREAMS: UpstreamItem[] = [
  // --- Tốc độ & Toàn cầu (Global Speed & Anycast) ---
  {
    id: "cloudflare",
    name: "Cloudflare (1.1.1.1)",
    url: "https://1.1.1.1/dns-query",
    description:
      "Phân giải nhanh nhất thế giới, Anycast toàn cầu, không lưu IP người dùng.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: true,
  },
  {
    id: "google",
    name: "Google Public DNS",
    url: "https://dns.google/dns-query",
    description:
      "Hạ tầng ổn định từ Google, DNSSEC đầy đủ, hỗ trợ chuẩn RFC 8484.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: true,
  },
  {
    id: "opendns",
    name: "Cisco Umbrella (OpenDNS)",
    url: "https://doh.opendns.com/dns-query",
    description:
      "Dịch vụ DNS Anycast danh tiếng từ Cisco, độ tin cậy và hiệu năng cao.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: false,
  },
  {
    id: "dnssb",
    name: "DNS.SB",
    url: "https://doh.dns.sb/dns-query",
    description:
      "Hỗ trợ DNSSEC, QNAME minimization, cam kết không ghi nhật ký.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: false,
  },

  // --- Bảo mật & Chống Mã độc (Security & Threat Protection) ---
  {
    id: "quad9",
    name: "Quad9 (9.9.9.9)",
    url: "https://dns.quad9.net/dns-query",
    description:
      "Tổ chức phi lợi nhuận Thụy Sĩ, tự động chặn domain mã độc & lừa đảo theo thời gian thực.",
    tag: "security",
    tagLabel: "🛡️ Bảo mật",
    enabled: false,
  },
  {
    id: "cloudflare-security",
    name: "Cloudflare 1.1.1.2 (Chống Malware)",
    url: "https://security.cloudflare-dns.com/dns-query",
    description:
      "Tự động chặn các website phát tán mã độc, botnet và ransomware qua dữ liệu Cloudflare Radar.",
    tag: "security",
    tagLabel: "🛡️ Bảo mật",
    enabled: false,
  },
  {
    id: "dns4eu",
    name: "DNS4EU Protective",
    url: "https://protective.joindns4.eu/dns-query",
    description:
      "Sáng kiến DNS bảo mật của Liên minh Châu Âu (EU), bảo vệ người dùng khỏi mã độc.",
    tag: "security",
    tagLabel: "🛡️ Bảo mật",
    enabled: false,
  },
  {
    id: "cira-shield",
    name: "CIRA Canadian Shield",
    url: "https://protected.canadianshield.cira.ca/dns-query",
    description:
      "DNS bảo vệ chống phishing và phần mềm độc hại, vận hành bởi cơ quan quản trị .CA.",
    tag: "security",
    tagLabel: "🛡️ Bảo mật",
    enabled: false,
  },

  // --- Chặn quảng cáo & Quyền riêng tư (Ad-blocking & Privacy) ---
  {
    id: "adguard",
    name: "AdGuard DNS",
    url: "https://dns.adguard-dns.com/dns-query",
    description:
      "Tự động lọc quảng cáo, trình theo dõi và banner gián điệp ở cấp độ DNS.",
    tag: "adblock",
    tagLabel: "🛑 Chặn QC",
    enabled: false,
  },
  {
    id: "controld-adblock",
    name: "Control D (Ads & Tracking)",
    url: "https://freedns.controld.com/p2",
    description:
      "Chặn mã độc + quảng cáo và các mạng lưới thu thập dữ liệu người dùng.",
    tag: "adblock",
    tagLabel: "🛑 Chặn QC",
    enabled: false,
  },
  {
    id: "rethinkdns",
    name: "RethinkDNS",
    url: "https://sky.rethinkdns.com/dns-query",
    description:
      "Máy chủ phân giải mã nguồn mở chạy trên 200+ điểm mạng Cloudflare, không lưu log.",
    tag: "security",
    tagLabel: "🔒 Riêng tư",
    enabled: false,
  },
  {
    id: "mullvad",
    name: "Mullvad DoH",
    url: "https://dns.mullvad.net/dns-query",
    description:
      "Chính sách quyền riêng tư nghiêm ngặt từ nhà cung cấp VPN Mullvad Thụy Điển.",
    tag: "security",
    tagLabel: "🔒 Riêng tư",
    enabled: false,
  },
  {
    id: "wikimedia",
    name: "Wikimedia DNS",
    url: "https://wikimedia-dns.org/dns-query",
    description:
      "Vận hành bởi Quỹ Wikimedia (Wikipedia), không lọc, không ECS, bảo vệ quyền riêng tư.",
    tag: "security",
    tagLabel: "🔒 Riêng tư",
    enabled: false,
  },

  // --- Gia đình & Bảo vệ Trẻ em (Family & Parental Control) ---
  {
    id: "cloudflare-family",
    name: "Cloudflare 1.1.1.3 (Gia đình)",
    url: "https://family.cloudflare-dns.com/dns-query",
    description:
      "Chặn mã độc và lọc các trang web nội dung người lớn, cờ bạc phù hợp gia đình.",
    tag: "family",
    tagLabel: "👨‍👩‍👧 Gia đình",
    enabled: false,
  },
  {
    id: "cleanbrowsing",
    name: "CleanBrowsing Family",
    url: "https://doh.cleanbrowsing.org/doh/family-filter/",
    description:
      "Bộ lọc nghiêm ngặt hàng đầu thế giới dành cho trường học và gia đình có trẻ nhỏ.",
    tag: "family",
    tagLabel: "👨‍👩‍👧 Gia đình",
    enabled: false,
  },
  {
    id: "opendns-family",
    name: "OpenDNS FamilyShield",
    url: "https://doh.familyshield.opendns.com/dns-query",
    description:
      "Tự động khóa các trang web người lớn và nội dung không phù hợp cho trẻ em.",
    tag: "family",
    tagLabel: "👨‍👩‍👧 Gia đình",
    enabled: false,
  },
];

export const DEFAULT_BLOCKLISTS: BlocklistItem[] = [
  {
    id: "chongluadao",
    name: "Chống Lừa Đảo (HieuPC) 🇻🇳",
    url:
      "https://raw.githubusercontent.com/chongluadao/cld-blocklist/master/domains.txt",
    description:
      "Danh sách bảo vệ người dùng Việt Nam chống website giả mạo, lừa đảo tài chính.",
    category: "vn",
    categoryLabel: "🇻🇳 Việt Nam",
    enabled: true,
  },
  {
    id: "oisd",
    name: "OISD Basic",
    url: "https://basic.oisd.nl",
    description:
      "Danh sách được tinh chỉnh tỉ mỉ, chặn hiệu quả và không gây lỗi trang.",
    category: "privacy",
    categoryLabel: "⚡ Tinh gọn",
    enabled: true,
  },
  {
    id: "stevenblack",
    name: "StevenBlack Unified",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    description:
      "Nguồn tổng hợp kinh điển chặn quảng cáo, tracking và phần mềm độc hại.",
    category: "general",
    categoryLabel: "🛡️ Toàn diện",
    enabled: true,
  },
  {
    id: "adguard-simplified",
    name: "AdGuard DNS Filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
    description:
      "Bộ quy tắc chặn quảng cáo tối ưu hóa trực tiếp từ nhóm kỹ sư AdGuard.",
    category: "general",
    categoryLabel: "🛑 Quảng cáo",
    enabled: false,
  },
  {
    id: "urlhaus",
    name: "URLHaus Malware Filter",
    url:
      "https://raw.githubusercontent.com/curbengh/urlhaus-filter/master/urlhaus-filter-hosts.txt",
    description:
      "Cơ sở dữ liệu của Abuse.ch chuyên ngăn chặn máy chủ C2, botnet và ransomware.",
    category: "malware",
    categoryLabel: "☣️ Mã độc",
    enabled: false,
  },
  {
    id: "peter-lowe",
    name: "Peter Lowe's List",
    url:
      "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
    description:
      "Danh sách các máy chủ quảng cáo và theo dõi danh tiếng từ năm 1996.",
    category: "privacy",
    categoryLabel: "👁️ Tracking",
    enabled: false,
  },
];

// --- UpstreamCatalogCache: cache in-memory per-isolate (hot path 0 KV) ---

export class UpstreamCatalogCache {
  #items: UpstreamItem[] = [];

  get size(): number {
    return this.#items.length;
  }

  /** Lam moi cache tu KV (1 read). Loi → giu danh sach cu (cold start → rong). */
  async refresh(kv: Deno.Kv): Promise<void> {
    try {
      const entry = await kv.get<UpstreamItem[]>(CONFIG_KEYS.upstreamsCatalog);
      if (entry.value && Array.isArray(entry.value)) {
        this.#items = entry.value;
      }
    } catch (e) {
      console.error("UpstreamCatalogCache: loi refresh, giu danh sach cu:", e);
    }
  }

  /** Cap nhat lap tuc sau admin CRUD (instance dang phuc vu cau hinh do). */
  setItems(items: UpstreamItem[]): void {
    this.#items = items;
  }

  /** De test: ve trang thai rong. */
  reset(): void {
    this.#items = [];
  }

  /** Dong URL upstream dang bat, sap xep theo region node (xem selector.ts). */
  getActiveUpstreamUrls(nodeRegion: string | null): string[] {
    return selectUpstreamUrls(this.#items, nodeRegion);
  }
}

export const upstreamCatalog = new UpstreamCatalogCache();
