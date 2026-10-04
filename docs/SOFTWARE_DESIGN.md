# 🧩 Thiet ke Phan mem — deno-dns

> Spec chi tiet tung module, thuat toan, API. Bo sung cho [README](../README.md)
> (huong dan su dung) va [Kien truc](ARCHITECTURE.md) (tam nhin he thong).

## 1. Tong quan module

| Module       | File                | Dong | Public API                                                                                                                                                                                       |
| ------------ | ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Router       | `main.ts`           | 286  | `Deno.serve(handler)`                                                                                                                                                                            |
| DoH pipeline | `src/dns.ts`        | 253  | `handleDNSQuery(req, info)`, `corsHeaders`                                                                                                                                                       |
| KV layer     | `src/storage.ts`    | 375  | `initStorage`, `recordStat`, `getStats`, upstream/blocklist CRUD, whitelist, rewrite, `isBlocked`, `syncBlocklists`                                                                              |
| Auth         | `src/auth.ts`       | 156  | `hashPassword`, `verifyPassword`, `isSetupNeeded`, `checkAdminPassword`, `setAdminPassword`, `createSession`, `verifySession`, `deleteSession`, `getSessionIdFromRequest`, `authenticateRequest` |
| Rate limit   | `src/ratelimit.ts`  | 162  | `checkDohRateLimit`, `checkApiRateLimit`, `checkLoginRateLimit`, `recordLoginFailure`, `resetLoginFailure`, `checkSyncRateLimit`, `recordSyncTriggered`, `getRateLimitStats`                     |
| Catalog      | `src/catalog.ts`    | 233  | `DEFAULT_UPSTREAMS` (16), `DEFAULT_BLOCKLISTS` (6), `UpstreamItem`, `BlocklistItem`                                                                                                              |
| Dashboard    | `public/index.html` | 791  | SPA: `checkAuth`, `loadStats`, `loadCatalogs`, `loadRules`, `syncBlocklists`, `testQuery`                                                                                                        |

## 2. Router (main.ts) — bang dinh tuyen

Thu tu match (quan trong — sai thu tu se vo hieu bao mat):

1. `OPTIONS *` → 204 + `corsHeaders` (cho ca DoH va API).
2. Trich `clientIp`: `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for[0]` →
   `remoteAddr.hostname` → `127.0.0.1`.
3. DoH public: `pathname == /dns-query` (+ trailing slash) hoac `pathname == /`
   kem `content-type: application/dns-message` / `?dns=` / `?name=` →
   `handleDNSQuery(req, info)`. **Khong** qua API rate-limit (co bucket DoH
   rieng).
4. `/api/*` → `checkApiRateLimit(ip)` (2 req/s, burst 30) → 429 + `Retry-After`
   neu het token.
5. Public auth: `GET /api/auth-status`, `POST /api/setup` (chi khi
   `isSetupNeeded`), `POST /api/login` (kem login lockout), `POST /api/logout`.
6. Gate: moi `/api/*` con lai → `authenticateRequest(req)` (Bearer hoac cookie)
   → 401 neu fail.
7. Protected: `stats`, `upstreams (+/toggle)`, `blocklists (+/toggle)`,
   `whitelist`, `rewrites`, `sync` (cooldown), `change-password`.
8. Fallback: doc `public/index.html` → `text/html`; 404 neu thieu file.

`jsonResponse(data, status, extra)` luon kem `corsHeaders`.

## 3. DoH pipeline (src/dns.ts)

### 3.1. Parse 3 bindings (RFC 8484 + JSON)

- `POST`: `Content-Type: application/dns-message`, body = raw packet (gioi han
  4096 bytes → 400 neu vuot).
- `GET ?dns=<base64url>`: `decodeBase64Url` (chiu ca `-_/` va space→`+`, tu pad
  `=`).
- `GET ?name=&type=A|AAAA`: tu build query bang
  `dnsPacket.encode({type:query, id:random, flags:RECURSION_DESIRED, questions:[{type,name}]})`.
  Chi nhan A/AAAA (ep kieu).
- `Accept: application/dns-json` hoac `?name=` khong keu dns-message → sau khi
  forward, decode response roi tra JSON (phuc vu browser/curl test).

### 3.2. Decision table (uu tien giam dan)

| # | Dieu kien                                    | Hanh dong                                                                                                           | Stat                          |
| - | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1 | `isWhitelisted(domain)` suffix-match         | forward upstream                                                                                                    | WHITELISTED (dem vao allowed) |
| 2 | `getRewriteIP(domain)` exact hoac `*.domain` | self-answer: neu qtype khop family IP thi 1 answer TTL 300, nguoc lai NOERROR 0 answer; flag `AUTHORITATIVE_ANSWER` | REWRITE                       |
| 3 | `isBlocked(domain)` suffix-match             | self-answer `0.0.0.0` (A) / `::` (AAAA), TTL 300                                                                    | BLOCKED                       |
| 4 | default                                      | `recordStat ALLOWED` roi forward                                                                                    | ALLOWED                       |

Domain chuan hoa: `lowercase, trim, strip trailing dot`. Neu decode fail →
domain rong → bo qua policy, van forward (ghi `(unknown)`).

### 3.3. Thuat toan suffix-match

```
clean = lower(trim(domain)).stripTrailingDot()
parts = clean.split('.')
for i in 0..len(parts)-2:
    candidate = parts[i..].join('.')
    if kv.get(['blocked_domains', candidate]): return True
```

`ads.example.com` bi chan neu `example.com` hoac `ads.example.com` trong set.
Rewrite them wildcard: check exact truoc, roi `*.` + hau to.

### 3.4. Forward + failover

```
for url in getActiveUpstreamUrls():
    try POST url {content-type: dns-message} timeout 3000ms
    if ok: return 200 + body + Cache-Control: max-age=300
return 502 Upstream DNS Error
```

Neu catalog rong → fallback
`["https://1.1.1.1/dns-query", "https://dns.google/dns-query"]`.

## 4. Storage (src/storage.ts) — KV layer

- `initStorage()`: seed `upstreams_catalog` (kem migration tu key cu
  `upstreams: string[]`), seed `blocklists_catalog`, chuan hoa 3 counters ve
  `KvU64`.
- `recordStat(domain, status, ip)`: 1 atomic gom 2 `sum(1n)` (total +
  blocked/allowed) + 1 `set(logs/timestamp/uuid)`. Try/catch — log fail khong
  lam hong query DNS.
- `getStats()`: doc 3 counters (chiu KvU64/bigint/number) +
  `total_blocked_count` + 50 logs moi nhat.
- Catalog: get full array → map/filter trong RAM → set full array. Don gian,
  chap nhan race khi 2 admin sua dong thoi.
- `syncBlocklists()`: chi xu ly list `enabled`. Moi list: fetch timeout 15s →
  split line → `extractDomainFromLine` → `atomic.set` batch 500. Tong `count` la
  gan dung (trung giua cac list).

### Parser `extractDomainFromLine` (3 format)

1. Bo dong trong, `#...`, `!...`. Cat comment `#` cuoi dong.
2. Adblock `||example.com^` → regex `/^\|\|([a-zA-Z0-9.-]+)\^/`.
3. Hosts `0.0.0.0 example.com` → lay cot 2, loai localhost/broadcasthost.
4. Plain `example.com` → 1 cot, chua `.`, khong chua `/`.

## 5. Auth (src/auth.ts) — password + session

- `hashPassword`: salt 16B → PBKDF2-SHA256 100k → 256 bit → `salthex:hashhex`.
- `verifyPassword`: derive lai, so sanh hex.
- `isSetupNeeded`: co env `ADMIN_PASSWORD` → false; nguoc lai check
  `auth/password_hash`.
- `checkAdminPassword`: env mode so sanh plaintext trim; KV mode verify PBKDF2.
- `createSession`: UUID + `expiresAt = now + 7d`, `kv.set` kem `{expireIn: 7d}`.
- `getSessionIdFromRequest`: uu tien Bearer, fallback cookie `doh_session`.
- State: `needsSetup → setup/login → session → logout/expire → login lai`.

## 6. Rate limit (src/ratelimit.ts) — bang thong so

| Bo gioi han | Thuat toan | Thong so | Khi vuot | |---|---|---|---|---| | DoH |
TokenBucket | refill 60/s, burst 120, per IP | 429 + Retry-After,
`totalDohBlocked++` | | API | TokenBucket | refill 2/s (~120/min), burst 30, per
IP | 429 JSON + Retry-After | | Login | Counter + lockout | 5 sai → khoa 15p |
429 + Retry-After, `totalLoginBlocked++` | | Sync | Cooldown global | 180s |
429 + Retry-After, `totalSyncBlocked++` |

Sweep moi 120s xoa bucket idle > 300s. `getRateLimitStats()` tra 4 metrics +
`lastSyncTimestamp`.

## 7. REST API reference

Protected yeu cau Cookie `doh_session` hoac `Authorization: Bearer`. 429 luon
kem header `Retry-After`.

| Method & Path                     | Body                                | 200                                                             | Loi                         |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------- | --------------------------- |
| GET `/api/auth-status`            | —                                   | `{authenticated, needsSetup}`                                   | —                           |
| POST `/api/setup`                 | `{password>=6}`                     | `{success, token}` + Set-Cookie                                 | 400 da setup / pass ngan    |
| POST `/api/login`                 | `{password}`                        | `{success, token}` + Set-Cookie                                 | 401 sai pass, 429 bi khoa   |
| POST `/api/logout`                | —                                   | `{success}` + clear cookie                                      | —                           |
| GET `/api/stats`                  | —                                   | `{total, blocked, allowed, domainCount, logs[50], ddosMetrics}` | 401                         |
| GET/POST/DELETE `/api/upstreams`  | `{name, url}` / `{id}`              | `{success, item?}` / array                                      | 401                         |
| POST `/api/upstreams/toggle`      | `{id, enabled}`                     | `{success}`                                                     | 401                         |
| GET/POST/DELETE `/api/blocklists` | `{name, url}` / `{id}`              | tuong tu                                                        | 401                         |
| POST `/api/blocklists/toggle`     | `{id, enabled}`                     | `{success}`                                                     | 401                         |
| GET/POST/DELETE `/api/whitelist`  | `{domain}`                          | `{success}` / `string[]`                                        | 401                         |
| GET/POST/DELETE `/api/rewrites`   | `{domain, ip}`                      | `{success}` / list                                              | 401                         |
| POST `/api/sync`                  | —                                   | `{success, count}`                                              | 401, 429 cooldown           |
| POST `/api/change-password`       | `{currentPassword, newPassword>=6}` | `{success}`                                                     | 400 sai hien tai / pass yeu |

## 8. Dashboard (public/index.html) — UI → API

- Header: nut Test (`GET /dns-query?name=`), Sync (`POST /api/sync`), Logout.
- 5 metric cards + DDoS panel ← `GET /api/stats` (poll 4s).
- Tab Upstream/Blocklist ← GET + toggle/add/delete endpoints.
- Tab Whitelist/Rewrite ← CRUD 2 API song song.
- Logs table ← `stats.logs`. Render bang innerHTML — can escape (xem muc 9).

## 9. Xu ly loi & Quan sat

| Tinh huong          | Tra ve                   | Log                         |
| ------------------- | ------------------------ | --------------------------- |
| Packet > 4096B      | 400 DNS Packet Too Large | khong                       |
| Base64 `?dns=` sai  | 400 Invalid DNS Request  | khong                       |
| Decode fail         | van forward `(unknown)`  | `console.warn`              |
| Het token DoH/API   | 429 + Retry-After        | metrics++                   |
| Login sai           | 401 + record failure     | khong                       |
| Upstream fail het   | 502 Upstream DNS Error   | khong                       |
| Fetch blocklist loi | bo qua list              | `console.error` kem ten+url |
| KV ghi log loi      | query van 200            | `console.error`             |

## 10. Roadmap ky thuat

1. Cache DNS theo TTL (`expireIn = min(ttl, 3600)`).
2. Health-check upstream + failover theo diem.
3. Sync co xoa domain list da tat (index nguoc domain→list).
4. Escape HTML logs + validate custom URL (https, deny localhost) chong SSRF.
5. Bulk import `upstream_dns_list.json` vao catalog.
6. `deno test` cho parser/suffix-match/bucket + CI fmt/lint/check.
7. Xoa code chet Fresh (`components/ islands/ utils.ts static/`).

---

_Phu thuoc ngoai duy nhat: `dns-packet@5.6.1` (npm:) + `node:buffer`._
