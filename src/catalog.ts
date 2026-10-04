export interface UpstreamItem {
  id: string;
  name: string;
  url: string;
  description: string;
  tag: "speed" | "security" | "adblock" | "family" | "custom";
  tagLabel: string;
  enabled: boolean;
  isCustom?: boolean;
}

export interface BlocklistItem {
  id: string;
  name: string;
  url: string;
  description: string;
  category: "vn" | "general" | "privacy" | "malware" | "custom";
  categoryLabel: string;
  enabled: boolean;
  count?: number;
  isCustom?: boolean;
}

export const DEFAULT_UPSTREAMS: UpstreamItem[] = [
  {
    id: "cloudflare",
    name: "Cloudflare (1.1.1.1)",
    url: "https://1.1.1.1/dns-query",
    description: "DNS phân giải nhanh nhất thế giới, hỗ trợ Anycast rộng khắp.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: true,
  },
  {
    id: "google",
    name: "Google Public DNS",
    url: "https://dns.google/dns-query",
    description: "Hạ tầng ổn định tuyệt đối từ Google, thời gian uptime 99.99%.",
    tag: "speed",
    tagLabel: "⚡ Tốc độ",
    enabled: true,
  },
  {
    id: "quad9",
    name: "Quad9 (9.9.9.9)",
    url: "https://dns.quad9.net/dns-query",
    description: "Tổ chức phi lợi nhuận Thụy Sĩ, tự động chặn domain mã độc & lừa đảo.",
    tag: "security",
    tagLabel: "🛡️ Bảo mật",
    enabled: false,
  },
  {
    id: "adguard",
    name: "AdGuard DNS",
    url: "https://dns.adguard-dns.com/dns-query",
    description: "Tự động lọc quảng cáo và trình theo dõi ở cấp độ upstream.",
    tag: "adblock",
    tagLabel: "🛑 Chặn QC",
    enabled: false,
  },
  {
    id: "mullvad",
    name: "Mullvad DoH",
    url: "https://dns.mullvad.net/dns-query",
    description: "Không lưu vết truy vấn, chính sách quyền riêng tư nghiêm ngặt.",
    tag: "security",
    tagLabel: "🔒 Riêng tư",
    enabled: false,
  },
  {
    id: "cloudflare-family",
    name: "Cloudflare 1.1.1.3 (Gia đình)",
    url: "https://family.cloudflare-dns.com/dns-query",
    description: "Tự động chặn mã độc và lọc nội dung người lớn dành cho trẻ em.",
    tag: "family",
    tagLabel: "👨‍👩‍👧 Gia đình",
    enabled: false,
  },
  {
    id: "cleanbrowsing",
    name: "CleanBrowsing Family",
    url: "https://doh.cleanbrowsing.org/doh/family-filter/",
    description: "Bộ lọc nghiêm ngặt bảo vệ an toàn cho trẻ em và thiết bị học tập.",
    tag: "family",
    tagLabel: "👨‍👩‍👧 Gia đình",
    enabled: false,
  },
];

export const DEFAULT_BLOCKLISTS: BlocklistItem[] = [
  {
    id: "chongluadao",
    name: "Chống Lừa Đảo (HieuPC) 🇻🇳",
    url: "https://raw.githubusercontent.com/chongluadao/cld-blocklist/master/domains.txt",
    description: "Danh sách bảo vệ người dùng Việt Nam chống website giả mạo, lừa đảo tài chính.",
    category: "vn",
    categoryLabel: "🇻🇳 Việt Nam",
    enabled: true,
  },
  {
    id: "oisd",
    name: "OISD Basic",
    url: "https://basic.oisd.nl",
    description: "Danh sách được tinh chỉnh tỉ mỉ, chặn hiệu quả và không gây lỗi trang.",
    category: "privacy",
    categoryLabel: "⚡ Tinh gọn",
    enabled: true,
  },
  {
    id: "stevenblack",
    name: "StevenBlack Unified",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    description: "Nguồn tổng hợp kinh điển chặn quảng cáo, tracking và phần mềm độc hại.",
    category: "general",
    categoryLabel: "🛡️ Toàn diện",
    enabled: true,
  },
  {
    id: "adguard-simplified",
    name: "AdGuard DNS Filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
    description: "Bộ quy tắc chặn quảng cáo tối ưu hóa trực tiếp từ nhóm kỹ sư AdGuard.",
    category: "general",
    categoryLabel: "🛑 Quảng cáo",
    enabled: false,
  },
  {
    id: "urlhaus",
    name: "URLHaus Malware Filter",
    url: "https://raw.githubusercontent.com/curbengh/urlhaus-filter/master/urlhaus-filter-hosts.txt",
    description: "Cơ sở dữ liệu của Abuse.ch chuyên ngăn chặn máy chủ C2, botnet và ransomware.",
    category: "malware",
    categoryLabel: "☣️ Mã độc",
    enabled: false,
  },
  {
    id: "peter-lowe",
    name: "Peter Lowe's List",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
    description: "Danh sách các máy chủ quảng cáo và theo dõi danh tiếng từ năm 1996.",
    category: "privacy",
    categoryLabel: "👁️ Tracking",
    enabled: false,
  },
];
