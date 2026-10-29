# cork-cache-n-queue

A lean pass-through reverse-proxy microservice for distributed-botnet mitigation, combining two independent gates in front of an upstream origin:

1. **Queue** - a Postgres-coordinated concurrency admission gate, capping how many in-scope requests from a single CIDR-masked client-IP group may be in flight at once, queueing a few more, and rejecting the rest with `429`.
2. **Cache** - a local, per-instance on-disk response cache. A cache hit is served immediately, bypassing the queue and the origin entirely.

Each gate has its own independent, configurable rule set (regex/includes/startsWith/endsWith + negation, matched against the request's URI path, headers, cookies, and query parameters) deciding which requests it applies to. Both gates are opt-in and off by default.

## Table of contents

- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Configuration reference](#configuration-reference)
- [Rule engine](#rule-engine)
- [Queue internals](#queue-internals)
- [Cache internals](#cache-internals)
- [Deployment](#deployment)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Operational notes](#operational-notes)

## How it works

Every request runs through a single fixed pipeline:

```
                    ┌──────────────┐     hit      ┌──────────────────┐
  request ─────────▶│ cache check  │─────────────▶│ serve from disk  │
                    └──────┬───────┘               └──────────────────┘
                           │ miss / out of scope
                           ▼
                    ┌──────────────┐   rejected   ┌──────────────────┐
                    │  queue gate  │─────────────▶│   429 response   │
                    └──────┬───────┘               └──────────────────┘
                           │ admitted / out of scope
                           ▼
                    ┌──────────────┐               ┌──────────────────┐
                    │    proxy     │──────────────▶│ upstream origin  │
                    │  (fetch())   │◀──────────────│                  │
                    └──────┬───────┘               └──────────────────┘
                           │ response streams back to client
                           ▼
                    ┌──────────────┐
                    │ cache write  │  (if eligible; never blocks the client stream)
                    └──────────────┘
```

A **cache hit bypasses the queue and the origin entirely** - this is deliberate: cached content never needs to compete for a queue slot or round-trip to the origin, which is both the fastest path and the one that does the most to protect the origin from load. Only a cache miss (or a request the cache ruleset doesn't apply to) goes through the queue gate before being proxied.

The two gates have different consistency models:

- The **queue** is coordinated across every instance of the service via Postgres (`sql/001-queue.sql`), so a concurrency cap is enforced correctly no matter how many replicas are running.
- The **cache** is entirely local to each instance - no Postgres, no cross-replica awareness, no shared storage assumed. It behaves like a standard reverse-proxy disk cache (e.g. nginx's `proxy_cache`): each replica builds up its own cache independently.

## Quickstart

```sh
npm install
CCNQ_UPSTREAM_URL=http://localhost:4000 npm start
```

That's it for the minimum viable run - `CCNQ_UPSTREAM_URL` is the only required setting. With `CCNQ_QUEUE_ENABLED` and `CCNQ_CACHE_ENABLED` both left at their default (`false`), the service is a plain pass-through proxy with no gating at all, which is a valid way to run it.

To exercise the queue locally you'll need Postgres - see [Deployment](#deployment) for `devops/compose.yaml`. The cache needs nothing beyond a writable directory (`CCNQ_CACHE_DIR`, default `./data/cache`).

## Configuration reference

Configuration is entirely environment-variable driven (`src/lib/config.js`), read once at process start. No config files are involved except the two rule-set JSON files described below.

### General / proxy

| Variable | Default | Description |
|---|---|---|
| `CCNQ_PORT` | `3000` | Port the service listens on. |
| `CCNQ_LOG_LEVEL` | `info` | Log level passed to `@ucd-lib/logger`. |
| `CCNQ_UPSTREAM_URL` | *(required)* | Base URL of the upstream origin to proxy to. Startup fails if this is unset or not a parseable URL. |
| `CCNQ_CLIENT_IP_HEADER` | *(unset)* | Name of a header to trust for the client's real IP address - e.g. `cf-connecting-ip` behind Cloudflare, or a custom header for local testing. If unset, the service **always** uses the raw socket address and ignores any such header the client sends, even if one happens to be present - there is no hardcoded trusted header name, so this must be explicitly opted into. |

### Postgres (only needed when the queue is enabled)

| Variable | Default | Description |
|---|---|---|
| `CCNQ_PG_HOST` | `localhost` | Postgres host. |
| `CCNQ_PG_PORT` | `5432` | Postgres port. |
| `CCNQ_PG_USER` | `postgres` | Postgres user. |
| `CCNQ_PG_PASSWORD` | `postgres` | Postgres password. |
| `CCNQ_PG_DATABASE` | `postgres` | Postgres database name. |
| `CCNQ_PG_SCHEMA` | `queue` | Schema the queue's tables/functions live in. Validated against `^[a-z_][a-z0-9_]*$` at startup (and rejected otherwise) since it's interpolated into the schema-creation SQL. |
| `CCNQ_PG_POOL_MAX` | `10` | Max connections in the queue's `pg.Pool`. |
| `CCNQ_PG_STATEMENT_TIMEOUT_MS` | `5000` | Postgres `statement_timeout` for the queue's pool, so a slow/stuck query can't hang the fail-open paths indefinitely. |

### Queue

| Variable | Default | Description |
|---|---|---|
| `CCNQ_QUEUE_ENABLED` | `false` | Enables the queue admission gate. |
| `CCNQ_QUEUE_RULES_FILE` | *(required if enabled)* | Path to the queue's ruleset JSON file - see [Rule engine](#rule-engine). |
| `CCNQ_QUEUE_METHODS` | *(empty = all methods)* | Comma-separated list of HTTP methods eligible for the queue gate at all, checked before the ruleset (e.g. `GET`). |
| `CCNQ_QUEUE_MAX_SERVED_PER_GROUP` | `1` | Max number of concurrent in-flight requests allowed per ip group. |
| `CCNQ_QUEUE_MAX_PENDING_PER_GROUP` | `5` | Max number of requests allowed to wait in the queue per ip group, once the active cap is full. |
| `CCNQ_QUEUE_PENDING_TIMEOUT_MS` | `10000` | Max time a request waits in the queue before giving up and returning `429`. |
| `CCNQ_QUEUE_POLL_INTERVAL_MS` | `250` | How often a queued request polls Postgres to check whether it's been promoted to active. |
| `CCNQ_QUEUE_IPV4_PREFIX_LENGTH` | `24` | IPv4 CIDR prefix length used to group client IPs. Must be a multiple of 8 (byte-aligned masking). |
| `CCNQ_QUEUE_IPV6_PREFIX_LENGTH` | `64` | IPv6 CIDR prefix length used to group client IPs. Must be a multiple of 16 (hextet-aligned masking). |
| `CCNQ_QUEUE_STALE_ACTIVE_MS` | `300000` | Age after which an "active" row is assumed abandoned (e.g. the instance that held it crashed) and is cleared out by the background sweep. |
| `CCNQ_QUEUE_SWEEP_INTERVAL_MS` | `60000` | Interval for the background sweep that runs crash-recovery reconciliation (`CCNQ_QUEUE_STALE_ACTIVE_MS`) and prunes fully-idle `group_state` rows (`CCNQ_QUEUE_IDLE_GROUP_MS`). |
| `CCNQ_QUEUE_IDLE_GROUP_MS` | `3600000` | How long a `group_state` row may sit with zero active and zero pending requests before the background sweep deletes it, so the table doesn't grow forever as new ip groups are seen. |
| `CCNQ_QUEUE_MAX_ACTIVE_DURATION_MS` | `0` (disabled) | Max time an admitted request may stay active before the queue forcibly destroys its connection, aborting the upstream fetch and freeing its slot. Opt-in only, since a nonzero value will cut off legitimately slow/long-lived responses - set it comfortably above your slowest expected upstream latency. |
| `CCNQ_QUEUE_ALLOWLIST` | *(empty)* | Comma-separated list of bare IPs, CIDR ranges, and/or `start-end` ranges (IPv4 or IPv6) that bypass the queue gate entirely, e.g. `203.0.113.5,198.51.100.0/24,192.0.2.10-192.0.2.20`. |

### Cache

| Variable | Default | Description |
|---|---|---|
| `CCNQ_CACHE_ENABLED` | `false` | Enables the disk cache gate. |
| `CCNQ_CACHE_RULES_FILE` | *(required if enabled)* | Path to the cache's ruleset JSON file - see [Rule engine](#rule-engine). |
| `CCNQ_CACHE_DIR` | `./data/cache` | Root directory for cached content on local disk. Should be instance-local/ephemeral storage - see [Cache internals](#cache-internals). |
| `CCNQ_CACHE_MAX_SIZE_BYTES` | `1073741824` (1 GiB) | Total on-disk cache size budget; least-recently-used entries are evicted once exceeded. |
| `CCNQ_CACHE_MAX_ITEM_SIZE_BYTES` | `10485760` (10 MiB) | Max size of a single response eligible for caching; larger responses still proxy through fine, they just aren't cached. |
| `CCNQ_CACHE_TTL_MS` | `60000` | Fallback TTL used when `Cache-Control` is absent, or whenever `CCNQ_CACHE_RESPECT_CACHE_CONTROL=false`. |
| `CCNQ_CACHE_RESPECT_CACHE_CONTROL` | `true` | Whether to honor the upstream response's `Cache-Control` header (see [Cache internals](#cache-internals) for exact semantics). |
| `CCNQ_CACHE_STRIP_SET_COOKIE` | `false` | When enabled, a `Set-Cookie` header on an otherwise-cacheable response is stripped before caching instead of blocking the cache write entirely. Opt-in because it can leak one client's cookie-gated personalization to others - see [Cache internals](#cache-internals). |
| `CCNQ_CACHE_METHODS` | `GET,HEAD` | Comma-separated list of HTTP methods eligible for caching at all, checked before the ruleset. |
| `CCNQ_CACHE_VARY_HEADERS` | *(empty)* | Comma-separated list of request header names folded into the cache key (e.g. `Accept-Encoding`), for responses that vary by them. |
| `CCNQ_CACHE_KEY_INCLUDE_QUERY` | `true` | Whether the request's query string is part of the cache key. |
| `CCNQ_CACHE_SWEEP_INTERVAL_MS` | `60000` | Interval for the background sweep that evicts expired entries nobody has looked up since they expired, and re-verifies the size budget. |

## Rule engine

Both `CCNQ_QUEUE_RULES_FILE` and `CCNQ_CACHE_RULES_FILE` point at a JSON file in the same shared format (`src/lib/rules/matcher.js`, `src/lib/rules/load-rules.js`), used to decide which requests a gate applies to - matched against the request's URI path, any header, any cookie, or any query parameter.

```
Ruleset  := Array<Group>              // matches if ANY group matches (OR)
Group    := Array<Condition>          // matches only if ALL conditions match (AND); a non-empty array is required
Condition:= {
  target:    "path" | "header" | "cookie" | "query",                // required
  name:      String,                                                // required for header/cookie/query, forbidden for path
  matchType: "regex" | "includes" | "startsWith" | "endsWith",      // optional for header/cookie/query, REQUIRED for path
  value:     String,                                                // required whenever matchType is set
  negate:    Boolean                                                // optional, default false
}
```

Notes:

- Groups are ANDed internally, groups are ORed against each other - this is standard disjunctive-normal-form, so a simple "match if ANY single condition matches" ruleset is just one condition per group.
- Omitting `matchType` on a `header`, `cookie`, or `query` condition makes it a **presence-only** check (true if that header/cookie/query param exists at all, regardless of value). This isn't allowed on `path` conditions, since the path is always present and that would be a no-op.
- `negate` inverts the whole condition, including for an absent header/cookie/query param - so `{"target": "cookie", "name": "no-cache", "negate": true}` means "this request does NOT carry a `no-cache` cookie."
- Method filtering (`CCNQ_QUEUE_METHODS` / `CCNQ_CACHE_METHODS`) is **not** expressed as a rule condition - it's a separate, cheaper pre-filter applied before the ruleset.
- Regexes are compiled once at startup, not per-request.
- An empty ruleset, or a ruleset containing only empty groups, never matches anything (a gate's rules file effectively disabling it) - this is a deliberate safe default for a security-relevant matcher, not a "match everything" fallback.

### Example: queue ruleset

`config/examples/queue-rules.example.json` - gate unauthenticated requests to binary-looking paths (pair with `CCNQ_QUEUE_METHODS=GET`):

```json
[
  [
    { "target": "path", "matchType": "regex", "value": "\\.(mp4|mov|zip|iso|bin|dmg|pdf)$" },
    { "target": "header", "name": "authorization", "negate": true },
    { "target": "cookie", "name": "session", "negate": true }
  ]
]
```

This is one group of three ANDed conditions: the path looks like a large binary file, there's no `Authorization` header, and there's no `session` cookie.

### Example: cache ruleset

`config/examples/cache-rules.example.json` - cache static asset paths, unless the client sent a `no-cache` cookie (pair with `CCNQ_CACHE_METHODS=GET,HEAD`):

```json
[
  [
    { "target": "path", "matchType": "startsWith", "value": "/static/" },
    { "target": "cookie", "name": "no-cache", "negate": true }
  ],
  [
    { "target": "path", "matchType": "regex", "value": "\\.(css|js|png|jpg|jpeg|svg|woff2)$" },
    { "target": "cookie", "name": "no-cache", "negate": true }
  ]
]
```

Two groups (ORed): "under `/static/`" or "looks like a static asset by extension", each still requiring the absence of a `no-cache` cookie.

### Example: query parameter condition

A `query` condition targets a single query string parameter by name, same as `header`/`cookie`:

```json
[
  [
    { "target": "query", "name": "preview", "matchType": "includes", "value": "1" }
  ]
]
```

Matches any request with a `preview` query parameter whose value contains `1` (e.g. `?preview=1`).

## Queue internals

The queue's state lives in Postgres under a dedicated schema (default `queue`, see `sql/001-queue.sql`):

- `group_state(ip_group PK, active_count, pending_count, last_active)` - one row per ip group, doubling as that group's mutex (every function below locks it with `FOR UPDATE` before mutating anything). `last_active` is bumped on every count-changing transition and is what the background sweep uses to prune fully-idle rows (see below) - without it the table would grow by one permanent row per distinct ip group ever seen.
- `active_request(request_id PK, ip_group, created)` - one row per in-flight (admitted) request.
- `pending_request(request_id PK, ip_group, created)` - one row per queued (waiting) request.
- Six plpgsql functions, each a single atomic round trip: `try_admit`, `enqueue_if_room`, `release_and_promote`, `expire_pending`, `reconcile_stale`, `prune_idle_groups`.

`Queue.admit()` (`src/lib/queue/index.js`) is the per-request state machine:

1. Out of scope (wrong method, allowlisted ip, or ruleset doesn't match) → always proceeds, no Postgres access at all.
2. In scope → try to claim an active slot (`try_admit`). If successful, proceed immediately and release-on-completion.
3. No active slot free → try to enqueue (`enqueue_if_room`). If the queue is also full, run `reconcile_stale` (crash recovery, see below) and reject with `429` + `Retry-After: 5`.
4. Enqueued → poll Postgres every `CCNQ_QUEUE_POLL_INTERVAL_MS` until promoted to active, the client disconnects, or `CCNQ_QUEUE_PENDING_TIMEOUT_MS` elapses.

**Fail-open by design:** every Postgres call in this path is wrapped so that a database error logs and lets the request through, rather than blocking traffic - *except* the deliberate timeout/expiry path, which fails closed with `429`. In other words, if Postgres is unavailable, the queue effectively turns itself off rather than taking the origin down with it; the operational tradeoff is that a Postgres outage removes bot-mitigation coverage, not origin availability.

`reconcile_stale` is the crash-recovery safety net: if an instance dies mid-request without releasing its active slot, that row would otherwise block real traffic forever. It deletes active rows older than `CCNQ_QUEUE_STALE_ACTIVE_MS` and recomputes `active_count` from what's actually left. It's still called opportunistically from `admit()` - when a group's queue is already full and about to reject a request - but it's also now run on a schedule (see below), so it no longer depends on that one contention path to ever fire.

`Queue.startSweeping()`/`stopSweeping()` (started in `src/server.js` alongside the cache's own sweep, stopped on graceful shutdown) run a background timer every `CCNQ_QUEUE_SWEEP_INTERVAL_MS` that calls `reconcile_stale` followed by `prune_idle_groups`. `prune_idle_groups` deletes any `group_state` row that's had zero active and zero pending requests for at least `CCNQ_QUEUE_IDLE_GROUP_MS` - this is what actually bounds the table's row count, since otherwise a row is never removed once an ip group is first seen.

**Force-disconnecting over-long requests**: setting `CCNQ_QUEUE_MAX_ACTIVE_DURATION_MS` (default `0`, disabled) attaches a timer to every admitted request; if it's still active once that duration elapses, the queue calls `res.destroy()` on it directly - not just cleaning up Postgres bookkeeping, but actually tearing down the client connection and (via the proxy's own close handler) aborting the in-flight upstream fetch, freeing the slot for the next queued request. This is a hard disconnect by design: no error body is sent, since headers may already be streaming. Leave it at `0` unless you specifically need a backstop against requests that hang open indefinitely - `reconcile_stale`'s 5-minute default already handles the case of an abandoned row from a *crashed* instance; this setting is for a request that's still alive but has simply run too long.

## Cache internals

- **Cache key** (`src/lib/cache/key.js`): a sha256 hash of method + path + (query string, if `CCNQ_CACHE_KEY_INCLUDE_QUERY`) + (configured `CCNQ_CACHE_VARY_HEADERS` values).
- **On-disk layout** (`src/lib/cache/store.js`): each entry is a `<hash>.meta.json` (status, headers, timestamps, size) + `<hash>.body` pair, sharded into a 2-level directory tree by hash prefix under `CCNQ_CACHE_DIR`. Writes go to `.tmp` siblings first and are atomically renamed into place only once complete, so a concurrent reader never observes a partial entry.
- **In-memory index** (`src/lib/cache/memory-index.js`): a single `Map` is the sole source of truth for hit/miss/TTL/eviction decisions - disk is written-through but never read to answer a hit/miss question. There is **no cold-start rehydration**: a freshly started process begins with an empty cache (which self-heals within one TTL window) and **no orphan-file garbage collection**, so `CCNQ_CACHE_DIR` should point at instance-local, ephemeral storage that's safe to wipe on restart (e.g. a Kubernetes `emptyDir`), not a durable volume.
- **Eviction**: least-recently-used entries are evicted synchronously on every write once `CCNQ_CACHE_MAX_SIZE_BYTES` is exceeded, plus a background sweep (`CCNQ_CACHE_SWEEP_INTERVAL_MS`) that also clears out expired-but-never-rechecked entries.
- **Cacheability**: with `CCNQ_CACHE_RESPECT_CACHE_CONTROL=true` (default), `max-age`/`s-maxage` sets the TTL when present, `no-store`/`private`/`no-cache` means never cached, and anything else falls back to `CCNQ_CACHE_TTL_MS`. A response carrying **any** `Set-Cookie` header is never cached by default - serving one client's cookies to another would be a correctness bug, not a configuration choice. Setting `CCNQ_CACHE_STRIP_SET_COOKIE=true` relaxes this: instead of refusing to cache, the `Set-Cookie` header is deleted from what's persisted (the live client that triggered the request still gets the real header; only the cached copy loses it) and the response is otherwise evaluated for cacheability as normal. This is an escape hatch for upstreams (e.g. CKAN) that stamp a session cookie onto every response including genuinely public ones - it only strips the header, it does **not** verify the response body itself is identical for every client, so only enable it for routes you've confirmed aren't personalized. `CCNQ_CACHE_MAX_ITEM_SIZE_BYTES` is enforced while streaming: if a response grows past the limit the write is silently abandoned without ever interrupting delivery to the client.
- **Thundering-herd dedup**: concurrent requests for the same not-yet-cached key don't each independently hit the queue/origin - the first becomes the "leader" (`DiskCache.beginWrite`) and the rest wait on its result (`DiskCache.getOrWait`), instance-local only, consistent with the cache's overall per-instance scope.
- **`X-Cache` response header**: every response carries `X-Cache: HIT` (served from disk), `MISS` (cache-eligible but not yet cached, proxied to the origin), or `BYPASS` (the cache is disabled, or this request isn't in the cache ruleset's scope at all) - set in `src/controllers/gateway.js`/`src/lib/proxy/index.js` after any upstream response headers are copied over, so it always reflects this service's own decision rather than being overwritten by an identically named upstream header.

## Deployment

- **`Dockerfile`** - `node:22`, no build step, `npm install --omit=dev`, `CMD ["node", "src/server.js"]`.
- **`devops/compose.yaml`** - a local Postgres instance for queue development (`docker compose -f devops/compose.yaml up -d`). Not needed if you're only exercising the cache.
- **`.cork-build`** - image build config for `cork-kube build gcb` / Google Cloud Build, per the standard UC Davis Library build convention.

For a Kubernetes/cork-kube deployment: only wire in the `CCNQ_PG_*` env vars if the queue is enabled; mount `CCNQ_CACHE_DIR` on ephemeral, instance-local storage (e.g. an `emptyDir` volume) rather than a shared/durable one, per the cache design above.

## Testing

```sh
npm test         # full suite; launches a throwaway Docker Postgres container automatically
npm run test:unit  # fast, Docker-free subset (pure unit tests + disk cache tests)
```

The only prerequisite for `npm test` is having Docker available - `test/mocha/root-hooks.js` starts a throwaway `postgres:16` container once for the whole run (`beforeAll`), runs `sql/001-queue.sql` against it, and tears it down afterward (`afterAll`). `npm run test:unit` skips that root hook entirely (`--no-config`) for instant, Docker-free feedback while iterating on pure logic.

Test tiers, by directory:

| Directory | Needs Docker? | Covers |
|---|---|---|
| `test/mocha/unit/` | No | Pure functions, no I/O: rule matcher, rule-file validation, cookie parsing, ip-group CIDR masking, allowlist parsing, cache-key derivation, `extractRequestFacts`, `proxy/headers.js`'s header-copying functions, `config.js`'s env-var parsing/defaults/validation, the `logger.js` wrapper, the gateway handler's outer error-catching (`createGatewayHandler`), and `server.js`'s `validateStartupConfig`. |
| `test/mocha/cache/` | No | `DiskCache` end-to-end against a tmp directory (hit/miss, TTL expiry, `Cache-Control` handling, oversized-write abort, LRU eviction, thundering-herd dedup, bodyless-response handling), plus `CacheStore` and `MemoryIndex` tested directly in isolation. |
| `test/mocha/queue-store/` | Yes | The plpgsql functions directly under real concurrency (`Promise.all` races); `Queue.admit()`'s state machine against fake req/res objects (admission caps, disconnect cleanup, a genuine `pendingTimeoutMs` timeout, the method pre-filter, stale-reconcile semantics); fail-open behavior against a fake store that rejects at each Postgres call site; and the `Db` wrapper itself (schema substitution, param passing, pool lifecycle). |
| `test/mocha/e2e/` | Yes | The full app wired up with a real HTTP server and a stub origin: cache-bypasses-queue, a bodyless/non-cacheable response, concurrent-miss dedup through real HTTP, queue saturation (admit/queue/429), allowlist/ruleset bypass, the configurable client-IP header, proxy correctness (body streaming, header stripping, multi-`Set-Cookie`, an unreachable origin's `502`, client-abort propagation), and the real `buildServer()`/`shutdown()` bootstrap wired against a live origin (and Postgres, when the queue is enabled). |

## Project layout

```
src/
  server.js                 bootstrap: config, logger, conditional queue/cache setup, graceful shutdown
  app.js                    express app (no body-parsing middleware - would break proxying)
  controllers/gateway.js    the cache -> queue -> proxy -> cache-write request handler
  lib/
    config.js               env-var driven configuration (single source of truth, see above)
    logger.js                @ucd-lib/logger wrapper
    cookies.js               hand-rolled Cookie header parser
    rules/                   shared DNF rule-matching engine used by both gates
    db/pool.js               pg.Pool wrapper used by the queue
    queue/                   admission gate: state machine, ip grouping, allowlist, Postgres store
    cache/                   disk cache: key derivation, disk I/O, in-memory LRU/TTL index
    proxy/                   fetch()-based streaming proxy to the upstream origin
sql/001-queue.sql            queue schema + plpgsql functions
config/examples/             example queue/cache ruleset JSON files
devops/compose.yaml          local dev Postgres
test/mocha/                  unit / cache / queue-store / e2e test tiers, see Testing above
```

## Operational notes

- **A `429` with `Retry-After: 5`** means the queue gate rejected the request outright (its ip group's active slots and pending queue were both full). Tune `CCNQ_QUEUE_MAX_SERVED_PER_GROUP`/`CCNQ_QUEUE_MAX_PENDING_PER_GROUP` to change how aggressively this triggers, and `CCNQ_QUEUE_PENDING_TIMEOUT_MS` to change how long a queued request waits before timing out into the same response.
- **Fail-open means a Postgres outage removes queue coverage, not origin availability** - if you see queue-related errors in the logs during a Postgres incident, expect traffic to pass straight through ungated rather than being blocked; this is intentional, not a bug.
- **Inspecting live queue state**: connect to Postgres and query the configured schema directly, e.g. `SELECT * FROM queue.group_state;` / `SELECT * FROM queue.active_request;` / `SELECT * FROM queue.pending_request;` (substitute your `CCNQ_PG_SCHEMA` if not using the default `queue`).
- **The cache has no admin/purge endpoint** - since it's per-instance and ephemeral by design, the operational lever is restarting the instance (empties the cache) or reducing `CCNQ_CACHE_TTL_MS` for faster turnover.
