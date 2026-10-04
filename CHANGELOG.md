# 📝 Changelog (CHANGELOG)

Tất cả thay đổi đáng chú ý của dự án **deno-dns**. Định dạng theo
[Keep a Changelog](https://keepachangelog.com/vi/1.1.0/); nguồn tham chiếu phiên
bản theo [Semantic Versioning](https://semver.org/lang/vi/).

## [0.2.0] — 2026-10-04

### Added

- multilingual documentation completion (README, ARCHITECTURE, SOFTWARE_DESIGN,
  CONTRIBUTING)

### Changed

- CI workflow refactored into separate lint/test/security/pages/preview
  workflows

### Fixed

- GitHub Pages 404 root cause identified and documented

### Removed

- (none for 0.2.0)

## [Unreleased]

### Added

- **Snapshot MVCC blocklist**: sync writes chunks `blocklist/v/{version}/{i}`
  first, manifest `blocklist/manifest` last as the sole interface; keeps 2
  versions in KV, auto-cleans stale chunks (self-healing if a previous write was
  interrupted).
- **Hot path 0 KV**: all DNS policy checks (`isWhitelisted` → `getRewriteIP` →
  `isBlocked`) resolve in-memory; benchmark `deno task bench-hot-path` (100k
  iterations, p50 ≈ 1.9µs — NFR p50 < 20ms).
- **Trust client IP from the platform only**: header `x-denoforwarded-for` +
  `remoteAddr.hostname`, private/loopback IPs from the header are rejected
  (anti-spoofing).
- **SSRF guard**: `assertSafeFetchUrl()` — `https://` only, blocks internal
  hostnames and private/link-local/metadata IPs for custom blocklist/upstream
  URLs.
- **Batched counter flush (atomic)**: 3 `KvU64` keys (`total/blocked/allowed`)
  in one `atomic().sum()` commit; steady-state flush never touches KV
  (idempotent); flush on SIGINT before exit.
- **Ring buffer log, 50 entries** in-memory instead of writing KV per request
  (security/privacy).
- **In-memory rate limit**: TokenBucket DoH 60 req/s burst 120, API 120 req/min,
  login 5 wrong keys locks 15 minutes, sync cooldown 180s; LRU cap 100k keys
  against memory DoS.
- **Validation scripts**: `deno task migrate-kv` (cleans up legacy
  `blocked_domains/*` keys), `deno task bench-hot-path`.
- **Test suite, 47 tests** across 7 modules (`*_test.ts` next to source).
- **CI/CD GitHub Actions** `.github/workflows/deno.yml`: lint · fmt · check ·
  test on every PR/push; dependency security scan; docs deploy to GitHub Pages.
- **PR preview** (job `preview`, plan §6.2): waits for the Deno Deploy
  `deploy/*` commit status, then posts a **sticky comment** on the PR — build
  state + console link, plus a **Preview URL** `https://<domain>.deno.dev` when
  the `DENO_DEPLOY_TOKEN` secret is set (without token: still green, just no URL
  line). PRs touching `docs/`, `README.md` or `CHANGELOG.md` upload artifact
  `docs-preview-pr-<n>` (retained 14 days). Fork PRs get no secrets → comment
  shows the docs part only.
- Docs: `docs/CONTRIBUTING.md`, `docs/CODE_OF_CONDUCT.md`, restructured
  `docs/ARCHITECTURE.md` §1–§11 (Vietnamese, C4 + ADR-1…ADR-7).

### Changed

- **Restructured `src/`** into layers (plan §4.2):
  `types/ kv/ blocklist/ counters/
  clientip/ ratelimit/ ssrf/ upstream/ auth/ dns/ api/ diag/`
  — new import paths, tests moved with their source.
- **Unified KV schema**: keys centralized in `src/kv/schema.ts` (`MANIFEST_KEY`,
  `chunkKey`, `STATS_KEYS`, `CONFIG_KEYS`, …).
- **`main.ts`**: now only init + CORS + rate-limit + dispatch; handlers split
  into `src/api/routes.ts` (auth + CRUD) and `src/diag/diag.ts`.
- **`DENO_KV_PATH`**: `openKv()` reads the env itself (Deno 2.9.7 does not read
  it automatically) — matches the README.
- NFR: p50 self-response < **20ms with 0 KV ops** (previously: <150ms with 2–3
  KV reads).

### Fixed

- Dashboard renders logs with HTML escaping (no more innerHTML XSS risk).
- New blocklist sync semantics: snapshot replaces the whole set — domains from
  disabled/failed sources no longer accumulate forever.
- Removed dead Fresh template code (`components/`, `islands/`, `utils.ts`,
  `static/`).

### Removed

- Flat KV keys `blocked_domains/*` from all code (still present in old data →
  run `deno task migrate-kv`).
- Per-request KV writes for logs/counters (replaced by ring buffer + batched
  flush).

## [0.1.0] — 2026-10-03

### Added

- DoH RFC 8484 (`POST /dns-query`, `GET ?dns=`, `GET ?name=&type=`).
- Lọc 4 tầng: Whitelist → Rewrite (wildcard) → Blocklist (suffix) → Forward.
- Catalog 6 nguồn blocklist + 16 upstream, failover tuần tự theo region.
- Dashboard NextDNS-style (`public/index.html`), admin API + session PBKDF2.
- Deno KV thuần — không DB ngoài; deploy Deno Deploy zero-config.

[Unreleased]: https://github.com/annguyen0/deno-dns/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/annguyen0/deno-dns/releases/tag/v0.1.0
