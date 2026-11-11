# CLAUDE.md

**Wander** — a Finland-only static web app that picks a random walking destination (a POI, a road point or a random point) within a distance or time budget and routes a round trip or one-way walk to it on a Leaflet map.

## Map

| Part | Where | Depth |
|---|---|---|
| Frontend — vanilla JS, no build step, served as-is | repo root (`index.html`, `*.js`, `*.css`, `fonts/`) | `docs/architecture.md`, design system `docs/design.md` |
| Cloud-backup API — Node 24 + Hono + Drizzle + Postgres, `wander-api.service` on the VPS | `server/` | `server/README.md` |
| Overpass client + junction/POI/road cache — Hono, `wander-junctions.service` on **shelly** | `junctions-cache/` | `junctions-cache/README.md` |
| Self-hosted OSRM-foot and Overpass on shelly, nginx confs, systemd units, drift checks | `deploy/` | `deploy/README.md`, `deploy/shelly-*/README.md` |
| Tests — loader, naming, sync harness, backend unit vs integration | `tests/`, `server/tests/`, `junctions-cache/tests/` | `tests/README.md` |
| Dev-only FIT validators and smoke page (own `package.json`, never deployed) | `tools/` | — |
| Design records | `docs/plans/` | read for rationale; never rewritten |

One Generate end to end (geocode → candidate pool → water screening → loop build → map) and the degraded OSRM mode: `docs/architecture.md`.

## Rules that bite

- **Script order is the dependency graph.** Frontend scripts are classic `defer`d tags sharing `globalThis`; `SCRIPT_DEPS` (`tests/helpers/script-deps.js`) is the ordered graph. Don't reorder `index.html` without it.
- **`tests/helpers/load.js` is the only way a test loads a repo-root browser script.**
- **`app.js` owns no feature** and nothing calls back into it; every route build goes through `withLoading` (`loading.js`), which is the one-build-at-a-time mutex.
- **`server/.env` is production.** Helm copies it into every worktree, so `pnpm db:migrate` can hit prod (it refuses destructive DDL from a worktree). Tests derive `wander_test` and hard-throw on any other name — `server/README.md`, `tests/README.md`.
- **The name was `explorer` until 2026-09-01.** Everything below the UI is now `wander`, except `docs/plans/` (records, never rewritten) and the permanent `/explorer` URL, kept because cloud-backup links travel as `/explorer/<username>#t=<token>`. The app reads either prefix and writes only `/wander/` (`parseUrlAccount` / `canonicalisePath` in `sync-init.js`).
- **Comments state the current contract and the non-obvious why.** Ticket tags (`finding #N`, `idea #N`) and accounts of removed code go in the commit message: neither resolves from the repo.
- **Four independent pnpm lockfiles** (root, `server/`, `junctions-cache/`, `tools/`) so pnpm does not hoist — `tests/README.md`. Only `server/` (forgejo-deploy) and `junctions-cache/` (shelly hook) are installed on deploy.

## Development

```bash
python3 -m http.server 8080     # frontend, repo root
pnpm test                       # frontend vitest; `pnpm test:related <file>` for a scoped run

cd server
pnpm dev                        # tsx watch
pnpm typecheck                  # strict tsc over src, tests and scripts
pnpm test                       # vitest against wander_test; waits for a sibling session's run
pnpm test:coverage              # fails under the coverage floor (root and junctions-cache have one too)
pnpm db:reset:test              # rebuild wander_test from the migration chain
pnpm db:migrate                 # PROD — guarded
pnpm build                      # tsc → dist/

cd junctions-cache && pnpm typecheck && pnpm test
```

## Deploy

`deploy` pushes to Forgejo; forgejo-deploy builds and migrates the server and rsyncs the frontend, then the local script restarts `wander-api`. Junctions-cache deploys separately through the `shelly` remote. Nginx/systemd files, the unit-install caveat and `ProtectHome=tmpfs`: `deploy/README.md`.
