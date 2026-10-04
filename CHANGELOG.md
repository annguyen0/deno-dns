# Changelog — deno-dns

All notable changes to this project are documented in this file, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Rendered docs site**: the GitHub Pages site now serves the documentation as
  formatted HTML, rendered from Markdown in CI (`deno task build-site`); the raw
  `.md` sources stay available next to each page.
- **Snapshot MVCC blocklist sync**: sync writes the chunks
  `blocklist/v/{version}/{i}` first and the manifest `blocklist/manifest` last —
  the manifest is the only interface readers use. Two versions are kept in KV
  and stale chunks are cleaned up automatically (self-healing if a previous
  write was interrupted).
- **Zero-KV hot path**: every DNS policy check (`isWhitelisted` → `getRewriteIP`
  → `isBlocked`) resolves in memory. Benchmark: `deno task bench-hot-path` (100k
  iterations, p50 ≈ 1.9µs; NFR p50 < 20ms).
- **Platform-only client IP**: the client IP is trusted only from the platform
  headers `x-denoforwarded-for` and `remoteAddr.hostname`; private and loopback
  addresses sent via headers are rejected (anti-spoofing).
- **SSRF guard**: `assertSafeFetchUrl()` — `https://` only, and internal
  hostnames plus private/link-local/metadata IPs are blocked for custom
  blocklist and upstream URLs.
- **Batched atomic counter flush**: the three `KvU64` counters
  (`total`/`blocked`/`allowed`) are written in one `atomic().sum()` commit.
  Steady-state flush never touches KV (idempotent); a final flush runs on SIGINT
  before exit.
- **In-memory log ring buffer (50 entries)** replaces the per-request KV writes
  (security/privacy).
- **In-memory rate limiting**: DoH TokenBucket 60 req/s (burst 120), API 120
  req/min, login lockout after 5 failures for 15 minutes, sync cooldown 180s;
  LRU cap of 100k keys as memory-DoS protection.
- **Validation scripts**: `deno task migrate-kv` (cleans up legacy
  `blocked_domains/*` keys) and `deno task bench-hot-path`.
- **Test suite**: 141 tests in 7 modules (`*_test.ts` next to the source).
- **CI/CD via GitHub Actions** — split workflows: lint · fmt · check · test on
  every push/PR, dependency audit (`deno audit`), docs deploy to GitHub Pages,
  and a PR preview job (see below).
- **PR preview** (plan §6.2): the preview job waits for the Deno Deploy
  `deploy/*` commit status and posts a sticky comment on the PR with the build
  state and console link, plus a direct Preview URL `https://<domain>.deno.dev`
  when the `DENO_DEPLOY_TOKEN` secret is set (without the token the job stays
  green, the URL line is just omitted). PRs touching `docs/`, `README.md`, or
  `CHANGELOG.md` upload a `docs-preview-pr-<n>` artifact (retained 14 days).
  Fork PRs receive no secrets, so their comment shows the docs part only.
- **Docs**: `docs/CONTRIBUTING.md`, `docs/CODE_OF_CONDUCT.md`, and a
  restructured `docs/ARCHITECTURE.md` (§1–§11, C4 model + ADR-1…ADR-7).

### Changed

- **Layered `src/` structure** (plan §4.2):
  `types/ kv/ blocklist/ counters/
  clientip/ ratelimit/ ssrf/ upstream/ auth/ dns/ api/ diag/`
  — new import paths, tests moved with their source.
- **Unified KV schema**: all key names centralized in `src/kv/schema.ts`
  (`MANIFEST_KEY`, `chunkKey`, `STATS_KEYS`, `CONFIG_KEYS`, …).
- **Leaner `main.ts`**: init + CORS + rate-limit + dispatch only; handlers split
  into `src/api/routes.ts` (auth + CRUD) and `src/diag/diag.ts`.
- **`DENO_KV_PATH` handling**: `openKv()` reads the environment variable itself
  (Deno 2.9.7 does not read it automatically) — now consistent with the README.
- **NFR tightened**: p50 self-response < **20ms with 0 KV ops** (previously <
  150ms with 2–3 KV reads).
- **CI/CD remediation**: the security workflow's invalid cross-file `needs` was
  removed (the dependency audit now actually runs) and its Deno version pinned;
  the orphaned monolith workflow that duplicated every run was deleted; the four
  split workflows got unique display names; Pages deploys run in the
  `github-pages` environment; `actions/checkout` and `actions/cache` were bumped
  to v5.
- **Docs site structure**: the Pages build now renders the Markdown to HTML and
  stages `docs/` as a directory with an HTML landing page, instead of copying
  the raw `README.md` to `index.html` (the previous staging produced an
  unrendered root and 404 doc links).
- **Changelog** rewritten as clear English release notes.

### Fixed

- Dashboard renders logs with HTML escaping (no more innerHTML XSS risk).
- **Blocklist sync semantics**: a sync snapshot replaces the whole set — domains
  from disabled or failed sources no longer accumulate forever.
- Removed dead Fresh template code (`components/`, `islands/`, `utils.ts`,
  `static/`).

### Removed

- Flat KV keys `blocked_domains/*` from all code (old data still needs
  `deno task migrate-kv`).
- Per-request KV writes for logs and counters (replaced by the ring buffer +
  batched flush).

## [0.2.0] — 2026-10-04

### Added

- English documentation set: README, ARCHITECTURE, SOFTWARE_DESIGN, and
  CONTRIBUTING translated/rewritten in English.

### Changed

- CI monolith workflow split into separate `deno-lint`, `deno-security`,
  `deno-pages`, and `deno-preview` workflows.

### Fixed

- Identified and documented the root cause of the GitHub Pages 404 (staging
  copied the unrendered `README.md` to `index.html` and flattened `docs/` into
  the site root).

### Removed

- (none for 0.2.0)

## [0.1.0] — 2026-10-03

### Added

- DoH server (RFC 8484): `POST /dns-query`, `GET ?dns=`, `GET ?name=&type=`.
- 4-layer filtering: Whitelist → Rewrite (wildcard) → Blocklist (suffix) →
  Forward.
- Catalog of 6 blocklist sources and 16 upstreams, with sequential region-based
  failover.
- NextDNS-style dashboard (`public/index.html`), admin API, PBKDF2 session
  authentication.
- Pure Deno KV storage — no external database; zero-config Deno Deploy.

[Unreleased]: https://github.com/annguyen0/deno-dns/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/annguyen0/deno-dns/releases/tag/v0.2.0
[0.1.0]: https://github.com/annguyen0/deno-dns/releases/tag/v0.1.0
