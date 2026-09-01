# Tests

Frontend suite at repo root; backend suite under `server/`. Junctions-cache has its own (`cd junctions-cache && pnpm test`).

```bash
pnpm test              # frontend: vitest run over tests/**/*.test.js
cd server && pnpm test # backend: vitest against explorer_test, never prod
```

## pnpm layout

The repo is four independent pnpm projects — root (frontend test devDeps), `server/`, `junctions-cache/`, `tools/` — each with its own lockfile. They are not a workspace (`packages: []` at root). Every one carries a `pnpm-workspace.yaml`, and every new sub-project must too: pnpm resolves its root by walking up to the nearest such file, so a sub-project without one is silently absorbed into the root install (`pnpm install` there installs the *root's* deps and skips the sub-project — no error, no lockfile, no `node_modules`).

Only two are `pnpm install`ed by the deploy chain: forgejo-deploy does `pnpm install --frozen-lockfile && pnpm build` in `server/`; the shelly post-receive hook does the same in `junctions-cache/`. Root is frontend test devDeps (frontend is copied as static files, no install). `tools/` is not part of the deployed site.

Overrides live in those `pnpm-workspace.yaml` files rather than a `pnpm` key in package.json because pnpm 11 no longer reads that key; both pins are security floors, so losing them is silent. `tests/pnpm-workspace-settings.test.js` guards both halves.

## Test DB safety

The server suite calls `truncateAll()` in `beforeEach`, so it must never touch the prod `explorer` DB. `server/tests/test-db.ts` resolves the connection: it derives the DB name from `.env`'s `DATABASE_URL` (or an explicit `TEST_DATABASE_URL`), forces the name to `*_test`, and **hard-throws** unless it ends in `_test` — so a prod-pointing `.env` (Helm copies it into worktrees) can never be truncated. `server/vitest.config.ts` sets `fileParallelism: false` because every DB-backed file shares the one `explorer_test` DB and would otherwise race on truncate. To recreate the test DB on a fresh box: `createdb explorer_test` (owner `explorer`), then apply migrations against it (`DATABASE_URL=postgresql://explorer:…@localhost:5432/explorer_test pnpm db:migrate`).

## localStorage is jsdom's, not Node's

`setup/jsdom-storage.js` (a vitest `setupFiles` entry) rebinds `localStorage`, `sessionStorage` and `Storage` onto globals from one jsdom realm. Node ships Web Storage as a getter-only `globalThis.localStorage` — behind `--experimental-webstorage` on 24, on by default from 25 — which vitest's jsdom environment cannot assign over, so the ambient one wins and the suite quietly stops testing browser storage: `Storage.prototype` spies never intercept a write, so every quota-recovery assertion passes vacuously, and with no `--localstorage-file` the getter itself throws. It is a no-op on a host Node without Web Storage, so nothing changes on the VPS's Node 24. `localstorage-binding.test.js` is the guard; reproduce the hostile ambient with `NODE_OPTIONS=--experimental-webstorage npx vitest run`.

## Frontend loader

**`helpers/load.js` is the only way a test loads a repo-root browser script.** `loadScripts('screening')` evaluates it and its dependencies in the current realm, in order. Don't hand-roll a bootstrap — the suite previously carried three idioms (`readFileSync`+`vm.Script`, `?raw`+`new Function`, side-effect ESM import) and a load-order fix applied to one silently missed the others.

`SCRIPT_DEPS` is the single copy of index.html's load-order graph. Direct dependencies only — `loadScripts` walks transitively. A module that gains a real dependency is one edit here rather than a hunt through every test that loads it. `helpers/load.test.js` fails RED if an edge contradicts index.html's `<script>` order.

Examples that match the map today: `screening → [geo-utils, novelty]`, `osrm → [net, geometry, loop-quality]`, `elevation → [net, geo-utils]`. geo-utils is only transitive for osrm (via geometry / loop-quality) — do not list it as a direct osrm dep.

`map-view.js` is loaded for real in `map-view.test.js` against a Leaflet stub, but it is not a SCRIPT_DEPS key: route-view tests fake it, and adding the key would force those tests to pull the real module via the reverse-completeness check. `app.js` is the same shape in `app.test.js` (faked render*/ExplorerSync collaborators; poi-types + settings loaded explicitly for the restore-order pin) — adding it as a key would pull the composition root into any suite that named it. `elevation` is a key (its tests load it for real, with net + geo-utils); route-view's Loaded-after sentence lists only the real-load collaborators so the same check does not pull elevation.js into those fakes.

### Transform-before-eval

`readScript(name)` returns source text. Two tests must transform it before evaluating:

- **fit-encoder** — string-inject an `_internals` export, then `evalScript` the patched source (side-effect load; return value unused).
- **corridor-junctions** — extract `fetchCorridorJunctions` from osrm.js, then a returning `new Function(...)()` wrapper. `evalScript` does not fit: it discards its return value, and the test needs the extracted function back. Pins finding #7559: start/radius travel in the POST body, never the query string.

### File naming

Most 1:1 coverage files are `tests/<module>.test.js` (the cloud-backup trio `sync` / `sync-flush` / `sync-sections` each has its own). Some suites are named after the behavior they pin, not the source file — grep the source name rather than assuming `tests/foo.test.js` exists:

| Source | Tests |
| --- | --- |
| `app.js` | `app.test.js` (composition-root wiring; not a SCRIPT_DEPS key) |
| `bbox.js` | `in-finland.test.js` |
| `export.js` | `export-download.test.js`, `export.test.js` |
| `visited.js` | `mark-visited.test.js`, `visited-sync.test.js` |
| `visits-io.js` | `visits-import.test.js` |
| `osrm.js` | `osrm.test.js`, `loop-vias.test.js`, `corridor-junctions.test.js` |
| `cloud-backup-ui.js` | `cloud-backup-ui.test.js` |
| `overpass.js` | `overpass.test.js` (query building / element parsing moved to `junctions-cache/tests/overpass-pools.test.ts`) |
| `route-view.js` | `route-view.test.js` (visited-button derivation still in `mark-visited.test.js`) |
| `visit-shape.js` | `visit-shape.test.js`, `visit-shape-parity.test.js` (client/server cap lockstep) |
| `storage.js` | `storage.test.js`, `geometry-keep-parity.test.js` (client/server newest-N geometry window) |
| `sync-sections.js` | `sync-sections.test.js`, `sync-restore.test.js` (restoreSections data-loss path) |

## Sync harness

`helpers/sync-harness.js` builds on the loader: it runs the three non-module sync IIFEs in the jsdom realm and owns the fetch/localStorage stubs, so each sync suite starts with one `installSyncLifecycle()` call. It also retires the previous instance via `ExplorerSync._destroy()` on every reload — sync.js's `'online'` listener and its flush worker's backoff timer would otherwise pile up on the shared window, all pumping the one `walk_sync_outbox` key.

## Backend layout

Dominant convention, not a hard rule:

- Colocated **`src/**/*.unit.test.ts`** — pure / fake-Db unit tests (no Postgres).
- **`server/tests/*.test.ts`** — mostly real-DB integration tests that truncate `explorer_test`.

The `.unit.` marker keeps same-named unit/integration pairs distinct at a glance (`sections.unit.test.ts` vs `sections.test.ts`). Import's unit file is `src/routes/import-validators.unit.test.ts`, not `import.unit.test.ts` — it covers the extracted validators, while `server/tests/import.test.ts` is the real-DB route.

A few files under `server/tests/` are DB-free: `username.test.ts` stubs db; `rate-limit-buckets.test.ts` mounts middleware with no Postgres; `test-db.test.ts` pins the `*_test` URL guard (finding #7777). Wordlists vs the client `USERNAME_RE` live in `src/username.unit.test.ts` (finding #7778).
