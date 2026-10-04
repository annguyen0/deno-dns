# 🛡️ deno-dns — DNS-over-HTTPS Serverless co Loc & Dashboard

> DoH server (RFC 8484) running on **Deno + Deno KV**: advertising content /
> document filtering / DNS spoofing prevention 🇻🇳, Local DNS Rewrite, Whitelist,
> failover many Upstream, DDoS/Brute-force protection, NextDNS-style Dashboard.

[🏗️ Kien truc](docs/ARCHITECTURE.md) ·
[🧩 Thiet ke phan mem](docs/SOFTWARE_DESIGN.md) · [📝 Changelog](CHANGELOG.md) ·
[🤝 Contributing](docs/CONTRIBUTING.md)

## 1. Tinh nang

- **DoH RFC 8484**: `POST application/dns-message` · `GET ?dns=<base64url>` ·
  `GET ?name=&type=` (JSON + dns-message). Lib `dns-packet@5.6.1`.
- **Loc 4 tang**:
  `Whitelist → Rewrite (wildcard *.domain) → Blocklist (suffix-match) → Forward Upstream`.
- **Blocklist Catalog**: 6 sources (Chong Lua Dao HieuPC 🇻🇳, OISD, StevenBlack default
 + AdGuard, URLHaus, Peter Lowe). Add/remove/toggle custom URL. Sync snapshot
 (chunks + manifest) each time, 15s/source timeout.
- **Upstream Catalog**: 16 upstreams (`src/upstream/catalog.ts`): Cloudflare
  1.1.1.1, Google, Quad9, AdGuard, Mullvad, Family, OpenDNS, DNS.SB... Failover
  sequentially, timeout 3s.
- **Dashboard** (`public/index.html`): metrics, DDoS panel, tabs
  Upstream/Blocklist/Whitelist+Rewrite, logs 50, poll 4s.
- **Bao mat**: PBKDF2-SHA256 100k + salt 16B · Session UUID TTL 7 days · Cookie
  HttpOnly SameSite=Strict + Bearer · DoH 60 req/s burst 120 · API 120 req/min ·
  Login 5 failed attempts 15 min · Sync cooldown 180s.
- **Luu tru**: 100% Deno KV, no external DB. Counter `KvU64` + atomic sum.

```
Client ── /dns-query (public) ──▶ Deno.serve (main.ts) ──▶ dns/auth/storage/ratelimit ──▶ Upstream DoH
Client ── /api/* (admin) ────────▶ gate session ──▶ CRUD catalog/rules/sync ──▶ Deno KV
```

## 2. Quickstart

Yeu cau: **Deno 2.x**.

```bash
deno task start   # http://localhost:8000
deno task dev     # watch mode
deno task test    # 47/47 test

# Required checks before PR (see docs/CONTRIBUTING.md):
deno task check && deno task lint && deno task fmt --check && deno test
deno task bench-hot-path   # benchmark hot path — p50 < 20ms, 0 KV op
deno task migrate-kv       # Delete legacy KV key blocked_domains/* (manual)
```

Implementation: `deno run --allow-net --allow-env --allow-read --unstable-kv main.ts`

**Initial admin setup**: open `http://localhost:8000` → enter password ≥ 6 characters
(`POST /api/setup`) → receive `doh_session` cookie. Or via UI:

```bash
ADMIN_PASSWORD="mat-khau-manh" deno task start
```

**Thu DoH ngay**:

```bash
curl "http://localhost:8000/dns-query?name=example.com&type=A" -H "Accept: application/dns-json"
```

DoH Testing button on Dashboard is the fastest way.

## 3. Cau hinh client

- **Firefox**: `about:config` → `network.trr.mode=3`,
  `network.trr.uri=https://<host>/dns-query`
- **Chrome/Edge**: Settings → Privacy → Use secure DNS → Custom →
  `https://<host>/dns-query`
- **iOS 14+**: profile `.mobileconfig` voi
  `ServerURL = https://<host>/dns-query`
- **Android**: dung app RethinkDNS/Nebulo voi Custom DoH endpoint (Private DNS root only supports DoT)

## 4. Bien moi truong

| Bien             | Mac dinh  | Mo ta                                                               |
| ---------------- | --------- | ------------------------------------------------------------------- |
| `ADMIN_PASSWORD` | trong     | Set → skip setup, login comparison directly. For Deploy/CI.    |
| `DENO_KV_PATH`   | Deploy KV | Path KV local. VD: `DENO_KV_PATH=./data/kv.sqlite deno task start`. |
| `PORT`           | `8000`    | `Deno.serve` tu doc khi deploy.                                     |

## 5. Deploy Deno Deploy

1. Push repo to GitHub. 2. dash.deno.com → New Project → entry `main.ts`. 3.
   Add env `ADMIN_PASSWORD`. 4. Default KV persistent. DoH endpoint:
   `https://<project>.deno.net/dns-query`.

> Rate-limit in-memory → per-instance, not global (trade-off note, see
> ADR-2).

## 6. API cheat-sheet (admin can session Cookie/Bearer)

`GET /api/auth-status` · `POST /api/setup|login|logout` · `GET /api/stats`
(total, blocked, allowed, domainCount, logs[50], ddosMetrics) · CRUD
`GET/POST/DELETE /api/upstreams|blocklists|whitelist|rewrites` ·
`POST /api/upstreams/toggle|/api/blocklists/toggle|/api/sync|/api/change-password`.
Chi tiet: [SOFTWARE_DESIGN §7](docs/SOFTWARE_DESIGN.md).

```bash
BASE=http://localhost:8000
curl -c jar.txt -X POST $BASE/api/login -H 'Content-Type: application/json' -d '{"password":"admin123"}'
curl -b jar.txt $BASE/api/stats
curl -b jar.txt -X POST $BASE/api/sync
curl -b jar.txt -X POST $BASE/api/rewrites -H 'Content-Type: application/json' -d '{"domain":"nas.lan","ip":"192.168.1.10"}'
```

## 7. Cau truc repo

```
main.ts (init + dispatch) · deno.json (tasks, "unstable": ["kv"]) · public/index.html (dashboard)
main.ts ─▶ src/api/routes.ts + src/diag/diag.ts ─▶ src/storage.ts (facade + sync)
src/
  types/ kv/ blocklist/ counters/ clientip/ ratelimit/ ssrf/ upstream/
  auth/ dns/ api/ diag/ bench/        # Details: docs/CONTRIBUTING.md §5
```

- `upstream_dns_list.json` (39KB): manual upstream catalog — not yet connected
  into code catalog; bulk import opportunity when needed (ARCHITECTURE §11).
- CI/CD: `.github/workflows/deno.yml` — lint · fmt · check · test · `deno audit`
  · deploy docs lên GitHub Pages.
- **Preview PR** (plan §6.2): comment sticky `🚀 Preview` trên mỗi PR — trạng
  Deno Deploy build status + link console, with Preview URL when DENO_DEPLOY_TOKEN added
  `DENO_DEPLOY_TOKEN` (optional — `docs/CONTRIBUTING.md` §6); PR edit `docs/`,
  `README.md` or `CHANGELOG.md` with artifact `docs-preview-pr-<n>`.

## 8. Gioi han da biet

- Rate-limit / logs / counters **in-memory per-instance** — not share between
  instance (multi-region requires KV atomic/Redis; see ADR-2).
- `upstream_dns_list.json` not imported into catalog (manual bulk import).
- Key KV legacy `blocked_domains/*` remaining in old data →
  `deno task migrate-kv`.
- Documentation in Vietnamese — limited to reviewers who read Vietnamese.

Resolved: snapshot sync replaces whole (no add-only, no delete)
· logs ring buffer in-memory (no KV write per request) · dashboard escape HTML
(no XSS innerHTML) · SSRF guard URL custom · co test (47) + CI.

## 9. Ghi nhan

OISD · StevenBlack · AdGuard · URLHaus · Peter Lowe · HieuPC ·
Cloudflare/Google/Quad9/Mullvad · `dns-packet` · Deno + Deno KV. MIT.
