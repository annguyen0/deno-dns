# 🤝 Contributing (CONTRIBUTING)

The **deno-dns** project — a DNS-over-HTTPS server on Deno + Deno KV.
Documentation and code comments use **English** (without required diacritics) —
please maintain this language when contributing, except for identifier/code in
English.

## 1. Requirements

- **Deno 2.9.7** (see `deno.json`; flag `"unstable": ["kv"]` is required on
  2.9.x because `Deno.openKv` is `@experimental`)

```bash
export PATH=/home/codespace/.deno/bin:$PATH   # if deno not in PATH
deno --version     # must be 2.9.7
```

## 2. Run locally

```bash
deno task start   # run server (http://localhost:8000)
deno task dev     # watch mode
```

## 3. Required checks (mandatory before PR)

```bash
deno task check   # type-check main.ts + src/**/*.ts
deno task lint    # deno lint
deno task fmt --check   # format (run `deno fmt` to auto-fix)
deno test         # entire test — must be 47/47 pass
```

Full CI simulation:

```bash
deno task check && deno task lint && deno task fmt --check && deno test
```

### Script validation

```bash
deno task migrate-kv       # remove legacy ["blocked_domains", ...] keys (manual, plan §7)
deno task bench-hot-path   # benchmark policy lookup — p50 < 20ms (plan §10)
```

- `migrate-kv` only DELETE `blocked_domains/*`; use `DENO_KV_PATH=<path>` to
  point to the KV you want to migrate (do not touch real KV if uncertain).
- `bench-hot-path` runs entirely in-memory (0 KV ops) — exit 1 if p50 ≥ 20ms.

## 4. Code conventions

- **File**: `kebab-case.ts`; test placed alongside source: `src/foo.ts` →
  `src/foo_test.ts` (module `module_name_test.ts`)
- **Export**: `PascalCase` for class (`BlocklistStore`, `QueryCounters`),
  `camelCase` for functions; constant `SCREAMING_SNAKE_CASE`
- **KV key**: only declare in `src/kv/schema.ts` (`MANIFEST_KEY`, `chunkKey()`,
  `STATS_KEYS`, ...) — **do not** scatter key names in other modules
- **Shared interface** (used by ≥ 2 modules): `src/types/index.ts`
- **Hot path DNS**: every policy check
  (`isWhitelisted`/`getRewriteIP`/`isBlocked`) must be in-memory lookup — **0
  Deno KV operation**; do not add `await kv.*` in the query path
- Documentation comments: English

## 5. src/ structure

```
src/
├ types/       # shared interfaces (ClientInfo, QueryStatus, BlocklistManifest...)
├ kv/          # Deno KV hand + schema (keys)
├ blocklist/   # store (in-memory) + snapshot (MVCC chunks/manifest) + suffix
├ counters/    # counter (atomic flush) + logring (ring buffer 50) + constants
├ clientip/    # trust IP ening (platform header) + constants
├ ratelimit/   # LruMap + TokenBucket (DoH/API/login/sync) + constants
├ ssrf/        # guard https-only + block IP in-code + constants
├ upstream/    # catalog (data + cache) + selector (region fallback)
├ auth/        # PBKDF2 + session
├ dns/         # pipeline (route) + policies (CORS/forward)
├ api/         # handler /api/* + validators
├ diag/        # /api/diag/headers, /api/stats
├ bench/       # bench-hot-path
└ storage.ts   # facade + sync (initStorage, syncBlocklists, getStats…)
```

## 6. Git & PR

- **Commit message** Conventional Commits style (see git history):
  `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `docs(scope): ...`,
  `refactor(scope): ...`, `chore(scope): ...`
- Each PR must pass: `check + lint + fmt + test` (CI runs automatically
  `.github/workflows/deno.yml`)
- Each PR receives **sticky `🚀 Preview`** comment (job `preview`, plan §6.2):
  deployment status + file changes + artifact.
- **Preview URL directly (optional)**: add secret `DENO_DEPLOY_TOKEN` (Deno
  Deploy token) at Settings → Secrets and variables → Actions; the job will call
  `https://api.deno.com/v1/projects/<project>/deployments` and output
  `https://<domain>.deno.dev` in the comment. Without token — job stays green,
  comment only missing line. Default project `deno-dns`; change via repository
  variable `DENO_DEPLOY_PROJECT`
- **Pages is a one-time condition** for `docs` job: enable Settings → Pages →
  Source = _GitHub Actions_ (if not enabled then `deploy-pages` fails with 404
  error)
- New tests: wrap IO/timer in `try/finally` (dispose, restore fetch stub…); each
  test reset singleton via `resetKv()`/`resetCounters()` if needed
- Do not commit environment files (`.env`) or KV data
- Test new: wrap IO/timer in `try/finally` (dispose, restore fetch stub…); each
  test reset singleton via `resetKv()`/`resetCounters()` if needed

## 7. Evidence/ADR

Architectural decisions recorded in `docs/ARCHITECTURE.md` §8 (ADR-1…ADR-7);
data model §7; threat model §9. Changes affecting architecture must update the
corresponding documentation in the same PR.
