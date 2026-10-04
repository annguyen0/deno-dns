# 🛡️ deno-dns — DNS-over-HTTPS Serverless co Loc & Dashboard

> DoH server (RFC 8484) chay tren **Deno + Deno KV**: loc quang cao / ma doc /
> lua dao 🇻🇳, Local DNS Rewrite, Whitelist, failover nhieu Upstream, chong
> DDoS/Brute-force, kem Dashboard NextDNS-style.

[🏗️ Kien truc](docs/ARCHITECTURE.md) ·
[🧩 Thiet ke phan mem](docs/SOFTWARE_DESIGN.md) · [📝 Changelog](CHANGELOG.md) ·
[🤝 Contributing](docs/CONTRIBUTING.md)

## 1. Tinh nang

- **DoH RFC 8484**: `POST application/dns-message` · `GET ?dns=<base64url>` ·
  `GET ?name=&type=` (JSON + dns-message). Lib `dns-packet@5.6.1`.
- **Loc 4 tang**:
  `Whitelist → Rewrite (wildcard *.domain) → Blocklist (suffix-match) → Forward Upstream`.
- **Blocklist Catalog**: 6 nguon (Chong Lua Dao HieuPC 🇻🇳, OISD, StevenBlack bat
  mac dinh + AdGuard, URLHaus, Peter Lowe). Them/xoa/toggle custom URL. Sync ghi
  snapshot (chunks + manifest) moi lan, timeout 15s/nguon.
- **Upstream Catalog**: 16 upstreams (`src/upstream/catalog.ts`): Cloudflare
  1.1.1.1, Google, Quad9, AdGuard, Mullvad, Family, OpenDNS, DNS.SB... Failover
  tuan tu, timeout 3s.
- **Dashboard** (`public/index.html`): metrics, DDoS panel, tabs
  Upstream/Blocklist/Whitelist+Rewrite, logs 50 moi nhat, poll 4s.
- **Bao mat**: PBKDF2-SHA256 100k + salt 16B · Session UUID TTL 7 ngay · Cookie
  HttpOnly SameSite=Strict + Bearer · DoH 60 req/s burst 120 · API 120 req/min ·
  Login 5 sai khoa 15p · Sync cooldown 180s.
- **Luu tru**: 100% Deno KV, khong DB ngoai. Counter `KvU64` + atomic sum.

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

# Cong kiem tra bat buoc truoc PR (xem docs/CONTRIBUTING.md):
deno task check && deno task lint && deno task fmt --check && deno test
deno task bench-hot-path   # benchmark hot path — p50 < 20ms, 0 KV op
deno task migrate-kv       # xoa khoa KV legacy blocked_domains/* (manual)
```

Thuc chat: `deno run --allow-net --allow-env --allow-read --unstable-kv main.ts`

**Setup admin lan dau**: mo `http://localhost:8000` → nhap mat khau ≥ 6 ky tu
(`POST /api/setup`) → nhan cookie `doh_session`. Hoac bo qua UI:

```bash
ADMIN_PASSWORD="mat-khau-manh" deno task start
```

**Thu DoH ngay**:

```bash
curl "http://localhost:8000/dns-query?name=example.com&type=A" -H "Accept: application/dns-json"
```

Nut "⚡ Thu nghiem DoH" tren Dashboard la cach nhanh nhat.

## 3. Cau hinh client

- **Firefox**: `about:config` → `network.trr.mode=3`,
  `network.trr.uri=https://<host>/dns-query`
- **Chrome/Edge**: Settings → Privacy → Use secure DNS → Custom →
  `https://<host>/dns-query`
- **iOS 14+**: profile `.mobileconfig` voi
  `ServerURL = https://<host>/dns-query`
- **Android**: dung app RethinkDNS/Nebulo voi Custom DoH endpoint (Private DNS
  goc chi ho tro DoT)

## 4. Bien moi truong

| Bien             | Mac dinh  | Mo ta                                                               |
| ---------------- | --------- | ------------------------------------------------------------------- |
| `ADMIN_PASSWORD` | trong     | Set → bo qua setup, login so sanh truc tiep. Dung cho Deploy/CI.    |
| `DENO_KV_PATH`   | Deploy KV | Path KV local. VD: `DENO_KV_PATH=./data/kv.sqlite deno task start`. |
| `PORT`           | `8000`    | `Deno.serve` tu doc khi deploy.                                     |

## 5. Deploy Deno Deploy

1. Push repo len GitHub. 2. dash.deno.com → New Project → entry `main.ts`. 3.
   Them env `ADMIN_PASSWORD`. 4. KV persistent mac dinh. DoH endpoint:
   `https://<project>.deno.net/dns-query`.

> Rate-limit in-memory → per-instance, khong global (trade-off chu y, xem
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
  auth/ dns/ api/ diag/ bench/        # chi tiet: docs/CONTRIBUTING.md §5
```

- `upstream_dns_list.json` (39KB): catalog upstream tĩnh **thủ công** — CHƯA nối
  vào code catalog; cơ hội bulk import khi cần (ARCHITECTURE §11).
- CI/CD: `.github/workflows/deno.yml` — lint · fmt · check · test · `deno audit`
  · deploy docs lên GitHub Pages · **preview artifact + comment sticky trên PR**
  khi docs thay đổi (plan §6.2).

## 8. Gioi han da biet

- Rate-limit / logs / counters **in-memory per-instance** — không share giữa các
  instance (multi-region cần KV atomic/Redis; xem ADR-2).
- `upstream_dns_list.json` chưa import vào catalog (bulk import thủ công).
- Key KV legacy `blocked_domains/*` còn sót trong data cũ →
  `deno task migrate-kv`.
- Tài liệu tiếng Việt — hạn chế với reviewer không đọc tiếng Việt.

Da giai quyet: sync snapshot thay the toan bo (khong con "chi them, khong xoa")
· logs ring buffer in-memory (khong con ghi KV/request) · dashboard escape HTML
(khong con XSS innerHTML) · SSRF guard URL custom · co test (47) + CI.

## 9. Ghi nhan

OISD · StevenBlack · AdGuard · URLHaus · Peter Lowe · HieuPC ·
Cloudflare/Google/Quad9/Mullvad · `dns-packet` · Deno + Deno KV. MIT.
