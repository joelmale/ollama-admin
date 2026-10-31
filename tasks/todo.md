# Pre-1.0 hardening

**Branch:** `fix/pre-1.0-hardening`
**Version bump:** minor (new behaviour: log purge job, healthcheck, coverage gate)

Source: the pre-1.0 review. Findings 1, 2 and 4 are out of scope by request.

## Plan

- [ ] 3 — Compose/install/README use the fork's image (`ghcr.io/joelmale/ollama-admin`), pinned tag
- [ ] 5 — Regenerate only replaces the final assistant message
- [ ] 6 — Chat streaming: save partial replies, abort upstream on disconnect, detect error lines, surface Ollama error bodies
- [ ] 7 — Session re-validates user role/active (short cache), shorter JWT maxAge
- [ ] 8 — Last-active-admin protection on PUT and DELETE; validate role; reject short passwords
- [ ] 9 — Server delete removes its logs and chats, explicit 404/409 messages
- [ ] 10 — Log retention purge job; wire or remove dead settings/config; doc drift
- [ ] 11 — Proxy endpoint allowlist for non-admins and API keys; timeouts; abort on disconnect
- [ ] 12 — Pull manager idle timeout, success required, stale jobs replaceable
- [ ] 13 — Coverage ratchet (server code) toward 75%; Playwright in CI
- [ ] 14 — Catalog: 502 instead of caching empty results, shared in-flight scrape, timeouts, parser fixture test
- [ ] 15 — Docker HEALTHCHECK, health version, SQLite backup before migrations, docs

Every fix gets a regression test.

## Review

_(filled in at the end)_
