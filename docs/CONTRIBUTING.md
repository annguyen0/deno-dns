# 🤝 Hướng dẫn đóng góp (CONTRIBUTING)

Dự án **deno-dns** — server DNS-over-HTTPS trên Deno + Deno KV. Tài liệu và
comment trong code dùng **tiếng Việt** (không bắt buộc dấu) — vui lòng giữ
nguyên ngôn ngữ này khi đóng góp, trừ identifier/code tiếng Anh.

## 1. Yêu cầu

- **Deno 2.9.7** (xem `deno.json`; cờ `"unstable": ["kv"]` là bắt buộc trên
  2.9.x vì `Deno.openKv` còn `@experimental`)
- Không cần build step, không cần DB ngoài

```bash
export PATH=/home/codespace/.deno/bin:$PATH   # nếu deno không có trong PATH
deno --version                                 # phải là 2.9.7
```

## 2. Chạy local

```bash
deno task start   # chạy server (http://localhost:8000)
deno task dev     # watch mode
```

## 3. Cổng kiểm tra (bắt buộc xanh trước khi PR)

```bash
deno task check   # type-check main.ts + src/**/*.ts
deno task lint    # deno lint
deno task fmt --check   # format (chạy `deno fmt` để tự sửa)
deno test         # toàn bộ test — phải 47/47 pass
```

Cổng đầy đủ (mô phỏng CI):

```bash
deno task check && deno task lint && deno task fmt --check && deno test
```

### Script validation

```bash
deno task migrate-kv       # xoa khoa legacy ["blocked_domains", ...] (manual, plan §7)
deno task bench-hot-path   # benchmark policy lookup — p50 < 20ms (plan §10)
```

- `migrate-kv` chỉ DELETE `blocked_domains/*`; dùng `DENO_KV_PATH=<path>` để trỏ
  vào KV cần migrate (không đụng KV thật nếu chưa chắc chắn).
- `bench-hot-path` chạy hoàn toàn in-memory (0 KV op) — exit 1 nếu p50 ≥ 20ms.

## 4. Quy ước code

- **File**: `kebab-case.ts`; test đặt cạnh nguồn: `src/foo.ts` →
  `src/foo_test.ts` (tên `module_name_test.ts`)
- **Export**: `PascalCase` cho class (`BlocklistStore`, `QueryCounters`),
  `camelCase` cho hàm; hằng số `SCREAMING_SNAKE_CASE`
- **KV key**: chỉ khai báo trong `src/kv/schema.ts` (`MANIFEST_KEY`,
  `chunkKey()`, `STATS_KEYS`, ...) — **không** đặt tên key rải rác trong module
  khác
- **Interface chia sẻ** (dùng ≥ 2 module): `src/types/index.ts`
- **Hot path DNS**: mọi policy check
  (`isWhitelisted`/`getRewriteIP`/`isBlocked`) phải là tra cứu in-memory — **0
  Deno KV operation**; không thêm `await kv.*` vào đường query
- Comment tài liệu: tiếng Việt

## 5. Cấu trúc src/

```
src/
├── types/       # interface chia sẻ (ClientInfo, QueryStatus, BlocklistManifest…)
├── kv/          # tay cầm Deno KV (index) + schema (khoa) + migration
├── blocklist/   # store (in-memory) + snapshot (MVCC chunks/manifest) + suffix
├── counters/    # counter (flush atomic) + logring (ring buffer 50) + constants
├── clientip/    # trust IP nen tang (platform header) + constants
├── ratelimit/   # LruMap + TokenBucket (DoH/API/login/sync) + constants
├── ssrf/        # guard https-only + block IP noi bo + constants
├── upstream/    # catalog (data + cache) + selector (region fallback)
├── auth/        # PBKDF2 + session
├── dns/         # pipeline (route) + policies (CORS/forward)
├── api/         # handler /api/* + validators
├── diag/        # /api/diag/headers, /api/stats
├── bench/       # bench-hot-path
└── storage.ts   # facade + sync (initStorage, syncBlocklists, getStats…)
```

## 6. Git & PR

- **Commit message** kiểu Conventional Commits (xem lịch sử git):
  `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `docs(scope): ...`,
  `refactor(scope): ...`, `chore(scope): ...`
- Mỗi PR phải giữ xanh: `check + lint + fmt + test` (CI chạy tự động
  `.github/workflows/deno.yml`)
- PR sửa `docs/`, `README.md` hoặc `CHANGELOG.md` sẽ nhận **comment preview** tự
  động (artifact `docs-preview-pr-<số>`, tải từ workflow run — plan §6.2)
- Test mới: bọc IO/timer trong `try/finally` (dispose, restore fetch stub…); mỗi
  test tự reset singleton qua `resetKv()`/`resetCounters()` nếu cần
- Không commit file môi trường (`.env`) hay dữ liệu KV

## 7. Bằng chứng/ADR

Quyết định kiến trúc ghi trong `docs/ARCHITECTURE.md` §8 (ADR-1…ADR-7); mô hình
dữ liệu KV §7; mô hình mối đe dọa §9. Thay đổi ảnh hưởng kiến trúc cần cập nhật
tài liệu tương ứng trong cùng PR.
