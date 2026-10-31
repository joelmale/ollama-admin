# Pre-1.0 hardening

**Branch:** `fix/pre-1.0-hardening`
**Version bump:** minor (new behaviour: log purge job, healthcheck, coverage gate)

Source: the pre-1.0 review. Findings 1, 2 and 4 are out of scope by request.

## Plan

- [x] 3 — Compose/install/README use the fork's image (`ghcr.io/joelmale/ollama-admin`), pinned tag
- [x] 5 — Regenerate only replaces the final assistant message
- [x] 6 — Chat streaming: save partial replies, abort upstream on disconnect, detect error lines, surface Ollama error bodies
- [x] 7 — Session re-validates user role/active (30s cache), JWT maxAge 7 days
- [x] 8 — Last-active-admin protection on PUT and DELETE; validate role; reject short passwords
- [x] 9 — Server delete removes its logs and chats, explicit 404/500 messages
- [x] 10 — Log retention purge job; wire or remove dead settings/config; doc drift
- [x] 11 — Proxy endpoint allowlist for non-admins and API keys; timeouts; abort on disconnect
- [x] 12 — Pull manager idle timeout, success required, stale jobs replaceable
- [x] 13 — Coverage ratchet (server code) to 75%+; Playwright in CI
- [x] 14 — Catalog: 502 instead of caching empty results, shared in-flight scrape, timeouts, parser fixture test
- [x] 15 — Docker HEALTHCHECK, health version, SQLite backup before migrations, docs

Every fix gets a regression test.

## Review

- Unit tests: 43 files, 360 tests; Playwright: 23 tests (run locally against the installed Chromium; CI installs its own). Server-side line coverage 49% → 86.6%; floors in `vitest.config.ts` ratchet up via `autoUpdate`.
- Verified in a locally built image: container reports `healthy`, `/api/health` shows the version and `logPurge: ok`, and a database without migration history is copied to `/data/backups` before migrating.
- Found while testing: ollama.com download counts were parsed as model sizes (fixed with the catalog work); the purge status was invisible to `/api/health` because `instrumentation.ts` is bundled separately (fixed).
- Not changed: the compare route (`/api/chats/[id]/compare`) still has the pre-fix streaming behaviour of finding 6 (no partial save, no abort on disconnect). It is now covered by tests.
- Not changed: PostgreSQL still uses `db push` because the migrations are SQLite-only; the entrypoint now explains a failed sync.
- Known: a legacy SQLite database with no migration history is re-synced with `db push` on every start, so it is also backed up on every start (newest 5 kept).
- Found while wiring e2e: `requireAdmin()` ignored `AUTH_DISABLED`, so admin APIs returned 403 and the servers page crashed in that mode (fixed).
