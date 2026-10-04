# 📝 Changelog (CHANGELOG)

Tất cả thay đổi đáng chú ý của dự án **deno-dns**. Định dạng theo
[Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); nguồn tham chiếu phiên
bản theo [Semantic Versioning](https://semver.org/lang/vi/).

## [Unreleased]

### Added

- **Snapshot MVCC blocklist**: sync ghi chunk `blocklist/v/{version}/{i}` trước,
  manifest `blocklist/manifest` cuối cùng làm giao diện duy nhất; giữ 2 version
  trong KV, tự dọn chunk cũ (self-healing nếu lần ghi trước bị ngắt).
- **Hot path 0 KV**: mọi policy check DNS (`isWhitelisted` → `getRewriteIP` →
  `isBlocked`) tra bộ nhớ in-memory; benchmark `deno task bench-hot-path` (100k
  lần, p50 ≈ 1.9µs — NFR p50 < 20ms).
- **Chỉ tin IP client từ nền tảng**: header `x-denoforwarded-for` +
  `remoteAddr.hostname`, từ chối IP riêng/loopback từ header (chống spoof).
- **SSRF guard**: `assertSafeFetchUrl()` — chỉ `https://`, chặn hostname nội bộ
  và IP riêng/link-local/metadata cho URL blocklist/upstream tùy chỉnh.
- **Counter flush gom (atomic)**: 3 khóa `KvU64` (`total/blocked/allowed`) trong
  1 commit `atomic().sum()`; flush rong không chạm KV (idempotent); flush khi
  SIGINT trước khi thoát.
- **Ring buffer log 50 mục** in-memory thay vì ghi KV mỗi request (bảo mật/riêng
  tư).
- **Rate limit in-memory**: TokenBucket DoH 60 req/s burst 120, API 120 req/min,
  login 5 sai khóa 15 phút, sync cooldown 180s; LRU cap 100k khóa chống DoS bộ
  nhớ.
- **Script validation**: `deno task migrate-kv` (dọn khóa legacy
  `blocked_domains/*`), `deno task bench-hot-path`.
- **Test suite 47 test** qua 7 module (`*_test.ts` cạnh nguồn).
- **CI/CD GitHub Actions** `.github/workflows/deno.yml`: lint · fmt · check ·
  test trên mỗi PR/push; quét bảo mật khóa phụ thuộc; deploy tài liệu lên GitHub
  Pages; PR sửa docs nhận **comment preview** (artifact `docs-preview-pr-<n>`,
  plan §6.2).
- Tài liệu: `docs/CONTRIBUTING.md`, `docs/CODE_OF_CONDUCT.md`, cấu trúc lại
  `docs/ARCHITECTURE.md` §1–§11 (tiếng Việt, C4 + ADR-1…ADR-7).

### Changed

- **Cấu trúc lại `src/`** theo lớp (plan §4.2):
  `types/ kv/ blocklist/ counters/
  clientip/ ratelimit/ ssrf/ upstream/ auth/ dns/ api/ diag/`
  — import paths mới, test di chuyển kèm nguồn.
- **Schema KV thống nhất**: khóa tập trung ở `src/kv/schema.ts` (`MANIFEST_KEY`,
  `chunkKey`, `STATS_KEYS`, `CONFIG_KEYS`, …).
- **`main.ts`**: chỉ còn khởi tạo + CORS + rate-limit + dispatch; handler tách
  sang `src/api/routes.ts` (auth + CRUD) và `src/diag/diag.ts`.
- **`DENO_KV_PATH`**: `openKv()` tự đọc env (Deno 2.9.7 không tự đọc) — khớp tài
  liệu README.
- NFR: p50 self-response < **20ms với 0 KV op** (trước: <150ms với 2–3 KV read).

### Fixed

- Dashboard render logs bằng escape HTML (không còn nguy cơ XSS innerHTML).
- Sync blocklist semantics mới: snapshot thay thế toàn bộ — domain của nguồn đã
  tắt/lỗi không còn bị tích tụ vĩnh viễn.
- Xóa code chết template Fresh (`components/`, `islands/`, `utils.ts`,
  `static/`).

### Removed

- Khóa KV phẳng `blocked_domains/*` khỏi toàn bộ code (còn trong data cũ → chạy
  `deno task migrate-kv`).
- Ghi KV theo request cho logs/counter (thay bằng ring buffer + flush gom).

## [0.1.0] — 2026-10-03

### Added

- DoH RFC 8484 (`POST /dns-query`, `GET ?dns=`, `GET ?name=&type=`).
- Lọc 4 tầng: Whitelist → Rewrite (wildcard) → Blocklist (suffix) → Forward.
- Catalog 6 nguồn blocklist + 16 upstream, failover tuần tự theo region.
- Dashboard NextDNS-style (`public/index.html`), admin API + session PBKDF2.
- Deno KV thuần — không DB ngoài; deploy Deno Deploy zero-config.

[Unreleased]: https://github.com/annguyen0/deno-dns/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/annguyen0/deno-dns/releases/tag/v0.1.0
