# 🧩 Software Design — deno-dns

> Spec detail per module, algorithm, API. Supplement for [README](../README.md)
> (usage) and [Architecture](ARCHITECTURE.md) (system overview).

## 1. Module Overview

| Module       | File               | Lines | Public API                                                                                                                                                                                       |
| ------------ | ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Router       | `main.ts`          | 286   | `Deno.serve(handler)`                                                                                                                                                                            |
| DoH pipeline | `src/dns.ts`       | 253   | `handleDNSQuery(req, info)`, `corsHeaders`                                                                                                                                                       |
| KV layer     | `src/storage.ts`   | 375   | `initStorage`, `recordStat`, `getStats`, upstream/blocklist CRUD, whitelist, rewrite, `isBlocked`, `syncBlocklists`                                                                              |
| Auth         | `src/auth.ts`      | 156   | `hashPassword`, `verifyPassword`, `isSetupNeeded`, `checkAdminPassword`, `setAdminPassword`, `createSession`, `verifySession`, `deleteSession`, `getSessionIdFromRequest`, `authenticateRequest` |
| Rate limit   | `src/ratelimit.ts` | 162   | `checkDohRateLimit`, `checkApiRateLimit`, `checkLoginRateLimit`, `recordLoginFailure`, `resetLoginFailure`, `checkSyncRateLimit`, `recordSyncTriggered`, `getRateLimitStats`                     |
| Catalog      | `src/catalog.ts`   | 233   | `DEFAULT_UPSTREAMS` (16), `DEFAULT_BLOCKLISTS` (6), `UpstreamItem`, `BlocklistItem`                                                                                                              |

## 2. Router (main.ts) — route matching order

Match order (critical — wrong order leads to security bypass):

1. `OPTIONS *` → 204 + `corsHeaders` (for all DoH and API).
2. Extract `clientIp`: `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for[0]` →
   `remoteAddr.hostname` → `127.0.0.1`.
3. DoH public: `pathname == /dns-query` (with trailing slash) or `pathname == /`
   with `?dns=` or `?name=` → `handleDNSQuery(req, info)`. **Do not** via API
   rate-limit (separate DoH bucket).
4. `/api/*` → `checkApiRateLimit(ip)` (2 req/s, burst 30) → 429 + `Retry-After`
   if out of tokens.
5. Public auth: `GET /api/auth-status`, `POST /api/setup` (only when
   `isSetupNeeded`), `POST /api/login` (with login lockout), `POST /api/logout`.
6. Gate: all remaining `/api/*` → `authenticateRequest(req)` (Bearer or cookie)
   → 401 if fail.
7. Protected: `stats`, `upstreams` (+/toggle), `blocklists` (+/toggle),
   `whitelist`, `rewrites`, `sync` (cooldown), `change-password`.
8. Fallback: `public/index.html` → `text/html`; 404 if file missing.

`jsonResponse(data, status, extra)` always includes `corsHeaders`.

## 3. DoH pipeline (src/dns.ts)

### 3.1. Parse 3 bindings (RFC 8484 + JSON)

- `POST`: `Content-Type: application/dns-message`, body = raw packet (limit 4096
  bytes → 400 if exceeded).
- `GET ?dns=<base64url>`: `decodeBase64Url` (handle `-_/` and space→`+`, pad `=`
  addition).
- `GET ?name=&type=A|AAAA`: build query using
  `dnsPacket.encode({type:query, id:random, flags:RECURSION_DESIRED, questions:[{type,name}]})`.
  Only accept A/AAAA (type cast).
- `Accept: application/dns-json` or `?name=` not matching dns-message → after
  forward, decode response then return JSON (browser/curl test service).

### 3.2. Decision table (priority order)

| # | Condition                                  | Action                                                                                                            | Stat                            |
| - | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1 | `isWhitelisted(domain)` suffix-match       | forward upstream                                                                                                  | WHITELISTED (increment allowed) |
| 2 | `getRewriteIP(domain)` exact or `*.domain` | self-answer: if qtype matches IP family then 1 answer TTL 300, else NOERROR 0 answer; flag `AUTHORITATIVE_ANSWER` | REWRITE                         |
| 3 | `isBlocked(domain)` suffix-match           | self-answer `0.0.0.0` (A) / `::` (AAAA), TTL 300                                                                  | BLOCKED                         |
| 4 | default                                    | `recordStat ALLOWED` then forward                                                                                 | ALLOWED                         |

Domain standardize: `lowercase, trim, strip trailing dot`. If decode fail →
empty domain → skip policy, still forward (log `(unknown)`).

### 3.3. Suffix-match algorithm

```
clean = lowercase(trim(domain)).stripTrailingDot()
parts = clean.split('.')
for i in 0..len(parts)-2:
    candidate = parts[i..].join('.')
    if kv.get(['blocked_domains', candidate]): return True
```

`ads.example.com` blocked if `example.com` or `ads.example.com` in set. Wildcard
check: verify exact first, then `*.` + suffix.

### 3.4. Forward + failover

```
for url in getActiveUpstreamUrls():
    try POST url {content-type: dns-message} timeout 3000ms
    if ok: return 200 + body + Cache-Control: max-age=300
return 502 Upstream DNS Error

If catalog empty → fallback
["https://1.1.1.1/dns-query", "https://dns.google/dns-query"]
```

## 4. Storage (src/storage.ts) — KV layer

- `initStorage()`: seed `upstreams_catalog` (with migration from old key
  `upstreams: string[]`), seed `blocklists_catalog`, normalize 3 counters to
  `KvU64`.
- `recordStat(domain, status, ip)`: 1 atomic batch of 2 `sum(1n)` (total +
  blocked/allowed) + 1 `set(logs/timestamp/uuid)`. Try/catch — log fail without
  impacting DNS query.
- `getStats()`: read 3 counters (KvU64/bigint/number) + `total_blocked_count` +
  50 latest logs.
- Catalog: get full array → map/filter in RAM → set full array. Simple, accept
  race when 2 admins modify simultaneously.
- `syncBlocklists()`: only process `enabled` lists. Each list: fetch timeout 15s
  → split lines → `extractDomainFromLine` → `atomic.set` batch 500. Total
  `count` is median between lists.

### Parser `extractDomainFromLine` (3 formats)

1. Skip blank lines, `#...`, `!...`. Remove trailing `#` comment.
2. Adblock `||example.com^` → regex `/^\|\|([a-zA-Z0-9.-]+)\^/`.
3. Hosts `0.0.0.0 example.com` → take 2nd column, remove
   localhost/broadcasthost.
4. Plain `example.com` → 1 segment, no `.`, no `/`.

## 5. Auth (src/auth.ts) — password + session

- `hashPassword`: 16B salt → PBKDF2-SHA256 100k → 256 bit → `salthex:hashhex`.
- `verifyPassword`: derive again, compare hex.
- `isSetupNeeded`: env `ADMIN_PASSWORD` → false; else check
  `auth/password_hash`.
- `checkAdminPassword`: env mode plaintext trim compare; KV mode verify PBKDF2.
- `createSession`: UUID + `expiresAt = now + 7d`, `kv.set` with
  `{expireIn: 7d}`.
- `getSessionIdFromRequest`: priority Bearer, fallback cookie `doh_session`.
- State: `needsSetup → setup/login → session → logout/expire → login restart`.

## 6. Rate limit (src/ratelimit.ts) — number table

| Limit | Algorithm         | Parameters                              | On exceed                                |   |
| ----- | ----------------- | --------------------------------------- | ---------------------------------------- | - |
| DoH   | TokenBucket       | refill 60/s, burst 120, per IP          | 429 + Retry-After, `totalDohBlocked++`   |   |
| API   | TokenBucket       | refill 2/s (~120/min), burst 30, per IP | 429 JSON + Retry-After                   |   |
| Login | Counter + lockout | 5 failed → lock 15 min                  | 429 + Retry-After, `totalLoginBlocked++` |   |
| Sync  | Global cooldown   | 180s                                    | 429 + Retry-After, `totalSyncBlocked++`  |   |

Sweep every 120s remove idle buckets > 300s. `getRateLimitStats()` returns 4
metrics + `lastSyncTimestamp`.

## 7. REST API reference

Protected requests require Cookie `doh_session` or `Authorization: Bearer`. 429
always includes `Retry-After`.

| Method & Path                     | Body                                | 200                                                             | Error                        |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------- | ---------------------------- |
| GET `/api/auth-status`            | —                                   | `{authenticated, needsSetup}`                                   | —                            |
| POST `/api/setup`                 | `{password>=6}`                     | `{success, token}` + Set-Cookie                                 | 400 already set / short pass |
| POST `/api/login`                 | `{password}`                        | `{success, token}` + Set-Cookie                                 | 401 wrong pass, 429 locked   |
| POST `/api/logout`                | —                                   | `{success}` + clear cookie                                      | —                            |
| GET `/api/stats`                  | —                                   | `{total, blocked, allowed, domainCount, logs[50], ddosMetrics}` | 401                          |
| GET/POST/DELETE `/api/upstreams`  | `{name, url}` / `{id}`              | `{success, item?}` / array                                      | 401                          |
| POST `/api/upstreams/toggle`      | `{id, enabled}`                     | `{success}`                                                     | 401                          |
| GET/POST/DELETE `/api/blocklists` | `{name, url}` / `{id}`              | similarly                                                       | 401                          |
| GET/POST/DELETE `/api/whitelist`  | `{domain}`                          | `{success}` / `string[]`                                        | 401                          |
| GET/POST/DELETE `/api/rewrites`   | `{domain, ip}`                      | `{success}` / list                                              | 401                          |
| POST `/api/sync`                  | —                                   | `{success, count}`                                              | 401, 429 cooldown            |
| POST `/api/change-password`       | `{currentPassword, newPassword>=6}` | `{success}`                                                     | 400 wrong current / weak new |

## 8. Dashboard (public/index.html) — UI → API

- Header: Test (`GET /dns-query?name=`), Sync (`POST /api/sync`), Logout.
- 5 metric cards + DDoS panel ← `GET /api/stats` (poll 4s).
- Tabs: Upstream/Blocklist ← GET + toggle/add/delete endpoints.
- Whitelist/Rewrite ← CRUD 2 API asynchronously.
- Logs table ← `stats.logs`. Render with HTML escape (see XSS section).

## 9. Error handling & Monitoring

| Status                  | Return                    | Log                           |
| ----------------------- | ------------------------- | ----------------------------- |
| Packet > 4096B          | 400 DNS Packet Too Large  | none                          |
| Base64 `?dns=` bad      | 400 Invalid DNS Request   | none                          |
| Decode fail             | still forward `(unknown)` | `console.warn`                |
| Token exhausted DoH/API | 429 + Retry-After         | metrics++                     |
| Login wrong             | 401 + record failure      | none                          |
| Upstream exhausted      | 502 Upstream DNS Error    | none                          |
| Fetch blocklist error   | skip list                 | `console.error` with name+url |
| KV log error            | query still 200           | `console.error`               |

## 10. Technical roadmap

1. DNS cache by TTL (`expireIn = min(ttl, 3600)`).
2. Health-check upstream + failover by point.
3. Sync with delete domain list (index domain→list).
4. Escape HTML logs + validate custom URL (https, deny localhost) against SSRF.
5. Bulk import `upstream_dns_list.json` into catalog.
6. `deno test` for parser/suffix-match/bucket + CI fmt/lint/check.
7. Remove dead Fresh code (`components/`, `islands/`, `utils.ts`, `static/`).

---

_Outside dependency: `dns-packet@5.6.1` (npm:) + `node:buffer`._
