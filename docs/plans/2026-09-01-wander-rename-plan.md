# Wander Rename Implementation Plan

**Goal:** Rename the project from `explorer` to `wander` across every layer — repo, checkout, Helm project, systemd unit, system user, webroot, Postgres, both shelly paths, and the mase.fi showcase — while keeping **both** `/explorer` and `/wander` serving permanently.

**Architecture:** Ordered so the live site is correct after every task, not just at the end. The nginx blocks go up **before** the frontend starts calling `/wander/api`, and the systemd unit file is renamed in the same task that installs it — both orderings exist to close windows where an ordinary `deploy` would break something. After Task 5 both URLs serve, the app canonicalises to `/wander`, and the host layer is still entirely named `explorer`; that is the natural stopping point if the cutover has to wait. Tasks 6–9 flip host identity, with one ~2 minute API outage confined to Task 6.

**Tech Stack:** vanilla JS frontend (no build), Hono + Drizzle + Postgres backend, nginx, systemd, Forgejo + `forgejo-deploy`, Helm (Postgres), bash.

**Design:** `docs/plans/2026-09-01-wander-rename-design.md`

---

## Two orderings that are load-bearing

Both were found by reviewing an earlier draft of this plan against live behaviour. Neither is obvious from the file list, and getting either wrong breaks a live deploy rather than a test.

**1. nginx before the frontend.** Task 4 points `API_BASE` at `/wander/api`. If that ships before Task 3 has installed the `/wander/api/` proxy block, every cloud-backup call 404s on the live site. The nginx work is therefore Task 3, ahead of the code that depends on it.

**2. The unit file renames with its install, not before.** `scripts/post-deploy.sh` is `exec deploy/check-unit-drift.sh`, which matches `deploy/<name>.service` against `/etc/systemd/system/<name>.service` **by exact filename** and exits 1 on MISSING. Renaming `deploy/explorer-api.service` → `wander-api.service` in the repo while the VPS still has the old unit installed makes every `deploy` fail its post-deploy hook — after a successful build and restart, so the failure is misleading. The unit rename therefore lives in Task 6, beside the `systemctl` install, and not in the Task 5 sweep.

---

## File Structure

**New:**
- `deploy/nginx-wander-headers.conf` — the shared security-header + CSP set, installed at `/etc/nginx/snippets/wander-headers.conf` and `include`d by both location blocks. Sole owner of the CSP.
- `deploy/nginx-wander.conf` — both static blocks plus both API proxy blocks. Owns routing and `try_files` only.

**Renamed:**
- `deploy/nginx-explorer.conf` → deleted, replaced by the two files above (Task 2)
- `deploy/explorer-api.service` → `deploy/wander-api.service` (Task 6, with its install)
- `server/tests/explorer-api-service.test.ts` → `server/tests/wander-api-service.test.ts` (Task 6 — it reads the unit file, so it moves with it)

**Modified:** `sync.js`, `sync-init.js`, `sync-helpers.js`, `app.js`, `cloud-backup-ui.js`, `storage.js`, `visits-io.js`, `history.js`, `server/package.json`, `tests/nginx-security.test.js`, the sync/app/cloud-backup test files, `tests/helpers/sync-harness.js`, `CLAUDE.md`, `deploy/README.md`, `server/README.md`, `tests/README.md`, and in the **helm** repo `scripts/forgejo-deploy` + `scripts/check-cache-headers.sh`.

**Explicitly untouched:** `docs/plans/*` (historical record), helm's eight incident-history comments, the Helm events log and every prose column.

---

## Task 1: helm repo — name-agnostic dispatcher

**Files:** (helm repo) `scripts/forgejo-deploy`, `scripts/check-cache-headers.sh`

**Contracts:**
- The `explorer)` case label becomes `explorer|wander)`. Inside it, the **seven** occurrences of `$PROJECTS/explorer` and `$FORGEJO_REPOS/explorer.git` become `$PROJECTS/$REPO` and `$FORGEJO_REPOS/$REPO.git`.
- `WEB_DIR` is **pinned** to `/var/www/html/wander` — deliberately *not* `$REPO`-derived. Deriving it would chain the webroot move to the Forgejo rename and force both into one window.
- The branch's closing `echo "✓ Built explorer @ $SHORT_SHA (restart via deploy)"` becomes `$REPO`-interpolated, so post-cutover deploy logs and ntfy stop saying "Built explorer".
- `scripts/check-cache-headers.sh:37`: `https://mase.fi/explorer/` → `https://mase.fi/wander/`.
- The eight incident-history comments mentioning `explorer` elsewhere in helm's scripts stay verbatim.

**Test Cases:** helm's `deploy-push.test.ts` / `build-lock.test.ts` must stay green — they reference `explorer` only in comments. Add none: this is a literal substitution in a bash `case`, and helm has no harness that executes `forgejo-deploy`.

**Constraints:** `/usr/local/bin/forgejo-deploy` is a **symlink** to this file. It goes live the instant helm lands on master — there is no staging. Land it deliberately, ahead of everything else.

**Verification:**
```
bash -n scripts/forgejo-deploy
build-lock pnpm vitest run deploy-push build-lock
deploy                                    # from helm
readlink -f /usr/local/bin/forgejo-deploy # resolves to the updated file
```

**Commit after passing.** `[Mode: Direct]`

---

## Task 2: nginx dual-URL config + snippet extraction (repo files)

**Files:**
- Create: `deploy/nginx-wander-headers.conf`, `deploy/nginx-wander.conf`
- Delete: `deploy/nginx-explorer.conf`
- Modify: `tests/nginx-security.test.js`

**Contracts:**

`nginx-wander-headers.conf` contains every `add_header` directive currently in the `/explorer` block — `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control`, `Content-Security-Policy` — byte-identical in value to today's, including every explanatory comment. No `location`, no `alias`, no `try_files`: it must be `include`-able inside any location context.

`nginx-wander.conf` contains four blocks:

| Block | `alias` | `try_files` | headers |
|---|---|---|---|
| `location /wander` | `/var/www/html/wander` | `$uri $uri/ /wander/index.html` | `include /etc/nginx/snippets/wander-headers.conf;` |
| `location /explorer` | `/var/www/html/wander` | `$uri $uri/ /explorer/index.html` | same include |
| `location /wander/api/` | — | — | proxy to `127.0.0.1:3700/api/` |
| `location /explorer/api/` | — | — | proxy to `127.0.0.1:3700/api/` |

Both API blocks keep `limit_req zone=api burst=10 nodelay;` and `proxy_set_header X-Forwarded-For $remote_addr;` (**not** `$proxy_add_x_forwarded_for` — finding #7895: a client-supplied XFF hop must never become the rate-limit or `ipFirstSeen` key).

**Test Cases** — `tests/nginx-security.test.js`. All four existing `describe` blocks (lines 33, 118, 144, 192) call `readDeploy('nginx-explorer.conf')` and must be repointed; the header assertions move to the snippet:

```js
// The header/CSP contract is asserted ONCE, against the snippet.
describe('deploy/nginx-wander-headers.conf (finding #7059)', () => {
    const headers = readDeploy('nginx-wander-headers.conf');

    test('sets CSP, framing, nosniff, and Permissions-Policy', () => { /* as today, vs `headers` */ });
    test('Referrer-Policy still sends an origin — no-referrer blanks the OSM map', () => { /* as today */ });
    test('CSP allows the real third parties and nothing via default-src *', () => { /* as today */ });
});

// The new assertion: neither static block may carry its own headers, and both
// must include the snippet. nginx add_header is all-or-nothing per context, so
// a block that grew its own copy would silently shadow the shared set.
describe('deploy/nginx-wander.conf static blocks', () => {
    const conf = readDeploy('nginx-wander.conf');

    test.each(['/wander', '/explorer'])('%s includes the shared header snippet', (path) => {
        const block = blockFor(conf, path);
        expect(block).toMatch(/include\s+\S*wander-headers\.conf;/);
        expect(block).not.toMatch(/add_header/);
    });

    test.each(['/wander', '/explorer'])('%s serves the wander webroot', (path) => {
        expect(blockFor(conf, path)).toMatch(/alias\s+\/var\/www\/html\/wander;/);
    });

    test('/explorer falls back to its own index so the SPA still boots on the old path', () => {
        expect(blockFor(conf, '/explorer')).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/explorer\/index\.html;/);
    });
});

// Both API proxies pinned, not just one (extends the finding #7582 block).
describe('deploy/nginx-wander.conf API proxies (finding #7582)', () => {
    const conf = readDeploy('nginx-wander.conf');

    test.each(['/wander/api/', '/explorer/api/'])('%s rate-limits and does not trust client XFF', (path) => {
        const block = blockFor(conf, path);
        expect(block).toMatch(/limit_req\s+zone=api\s+burst=10\s+nodelay;/);
        expect(block).toMatch(/X-Forwarded-For\s+\$remote_addr;/);
        expect(block).not.toMatch(/\$proxy_add_x_forwarded_for/);
    });
});
```

The `img-src` and `connect-src` derivation blocks keep their logic verbatim — they scan `map-view.js` and the frontend sources for hosts — and only change which file they read the CSP out of.

`blockFor(conf, path)` is a new local helper replacing today's `conf.split(...)[1]`, which cannot distinguish four blocks. It must match the location header exactly: `location /wander {` must not match `location /wander/api/ {`.

**Constraints:** the CSP string is a security boundary. It is **moved**, not rewritten — any change to its content is out of scope.

**Verification:**
```
pnpm vitest run nginx-security
rg -c add_header deploy/nginx-wander.conf    # → 0
```

**Commit after passing.** `[Mode: Direct]`

---

## Task 3: apply nginx + webroot on the VPS (zero downtime)

**Contracts:** after this task both URLs serve the current app and `/wander/api/` exists — which is Task 4's precondition.

1. `sudo mv /var/www/html/explorer /var/www/html/wander` — atomic rename, no reader interrupted
2. `sudo cp deploy/nginx-wander-headers.conf /etc/nginx/snippets/wander-headers.conf`
3. Edit `/etc/nginx/sites-enabled/default`: replace the existing `/explorer` and `/explorer/api/` blocks with the four blocks from `deploy/nginx-wander.conf`
4. `sudo nginx -t && sudo systemctl reload nginx`

**Verification:**
```
curl -sS -o /dev/null -w '%{http_code}\n' https://mase.fi/wander/
curl -sS -o /dev/null -w '%{http_code}\n' https://mase.fi/explorer/
curl -sS https://mase.fi/wander/api/health      # {"status":"ok"}
curl -sS https://mase.fi/explorer/api/health    # {"status":"ok"}
diff <(curl -sSI https://mase.fi/wander/ | rg -i '^(content-security|referrer|permissions|x-frame)') \
     <(curl -sSI https://mase.fi/explorer/ | rg -i '^(content-security|referrer|permissions|x-frame)')
```
Expected: both `200`, both health endpoints `ok`, and the header `diff` **empty** — a difference means the `include` did not land in one of the blocks, which is the exact CSP-drift hole the snippet exists to prevent.

**Constraints:** Task 1 must be deployed first, or the next push recreates `/var/www/html/explorer` and nginx serves a directory nothing writes to.

`[Mode: Direct]`

---

## Task 4: frontend dual-URL policy

**Files:**
- Modify: `sync.js`, `sync-init.js`
- Test: `tests/sync.test.js`, `tests/sync-restore.test.js`

**Contracts:** read either prefix, write only `/wander/`.

| Site | Now | After |
|---|---|---|
| `sync.js:25` | `API_BASE = '/explorer/api'` | `API_BASE = '/wander/api'` |
| `sync-init.js:41` | `location.pathname.match(/\/explorer\/([^/?#]+)/)` | matches `/(?:explorer\|wander)/` |
| `sync.js:183` | `origin + '/explorer/' + _username + '#t=' + _token` | `/wander/` |
| `sync.js:245` | `replaceState(…, '/explorer/' + username + '#t=' + token)` | `/wander/` |
| `sync.js:270`, `sync-init.js:230`, `sync-init.js:250` | `replaceState(…, '/explorer/')` | `/wander/` |

**Test Cases:**

```js
test('an old /explorer account link is still read as an account', () => {
    // pathname '/explorer/mase' must yield username 'mase' — this is how a
    // bearer token reaches a device that has not loaded since the rename.
});

test('a /wander account link is read as an account', () => { /* '/wander/mase' → 'mase' */ });

test('the address bar is canonicalised to /wander on arrival from /explorer', () => {
    // land on '/explorer/mase#t=<token>' → replaceState target starts '/wander/'
});

test('a shareable account link is always built on /wander', () => {
    expect(buildShareLink('mase', 'tok')).toBe('https://mase.fi/wander/mase#t=tok');
});

test('the prefix regex does not match a lookalike path', () => {
    // '/explorers/mase' and '/wanderlust/mase' must NOT yield a username —
    // the alternation needs its slashes, not a bare substring test.
});
```

**Constraints:**
- `API_BASE` stays one absolute constant, **not** derived from `location.pathname`. A page at `/explorer/…` calling `/wander/api` is same-origin and already permitted by `connect-src 'self'`.
- The username regex is the only place that accepts the old prefix. Do not add `explorer` fallbacks anywhere else.
- **Task 3 must be live before this ships**, or every cloud-backup call 404s.

**Verification:** `pnpm vitest run sync`, then in a browser confirm sync still works at both URLs.

**Commit after passing.** `[Mode: Direct]`

---

## Task 5: in-repo rename sweep

**Files:** `server/package.json`, `sync.js`, `sync-init.js`, `sync-helpers.js`, `app.js`, `cloud-backup-ui.js`, `storage.js`, `visits-io.js`, `history.js`, `tests/helpers/sync-harness.js`, the sync/app/cloud-backup test files, `CLAUDE.md`, `deploy/README.md`, `server/README.md`, `tests/README.md`

**Contracts:**
- `server/package.json` `name`: `explorer-api` → `wander-api`
- DOM event `explorer-sync-state-change` → `wander-sync-state-change` — dispatched in `sync.js`, listened for in `app.js` and `cloud-backup-ui.js`, asserted in four test files
- Globals `window.ExplorerSync` → `window.WanderSync` and `window.ExplorerSyncUI` → `window.WanderSyncUI` — ~195 occurrences across 21 files. These are the same class of purely-internal identifier as the DOM event: nothing in `index.html` or any external consumer references them. Renaming the event but not these would leave the rename half-adopted, which is worse than not starting.
- Docs: prose and paths only. `docs/plans/*` is **not** touched — add one line to `CLAUDE.md` noting that historical design docs use the old name.

**Constraints:**
- The unit file and its test are **not** in this task — see "Two orderings that are load-bearing".
- Verification greps must be **case-insensitive**. `rg -l explorer` is what let `ExplorerSync` hide through an entire earlier draft of this plan.

**Verification:**
```
pnpm vitest run
cd server && build-lock pnpm vitest run && build-lock tsc --noEmit
rg -li explorer --glob '!node_modules' --glob '!docs/plans'
```
Expected: suites green; the final grep returns only `deploy/nginx-wander.conf`, `sync.js`, `sync-init.js`, their tests, and `deploy/explorer-api.service` — every remaining hit either the deliberately-kept `/explorer` URL or the unit file Task 6 renames. Any other hit is a miss.

**Commit after passing.** `[Mode: Direct]`

---

## Task 6: the flip window (VPS, API down ~2 min)

**Files:** rename `deploy/explorer-api.service` → `deploy/wander-api.service` and `server/tests/explorer-api-service.test.ts` → `server/tests/wander-api-service.test.ts` **as part of this task**, committed immediately before the install below.

**Contracts:**

`deploy/wander-api.service`: `Description`, `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, `BindReadOnlyPaths` all move to `wander` / `~/Projects/wander`. The `# deploy-host: local` header stays — `check-unit-drift.sh` reads it.

`server/tests/wander-api-service.test.ts` keeps all three existing tests, retargeted at the renamed file — the isolation contract is unchanged:
- `runs as the explorer system user, not the interactive account` → renamed to say `wander`, asserting `User=wander`
- `hides /home except the server tree and enables the hardening block` → `BindReadOnlyPaths` now `~/Projects/wander/server`; `ProtectHome=tmpfs` unchanged (`yes` would overmount `/home` and hide the bind target)
- `caps process memory so a fat GET cannot OOM the host (finding #7558)` → unchanged

Then, in order:

1. `sudo systemctl stop explorer-api`
2. `mv ~/Projects/explorer ~/Projects/wander && git -C ~/Projects/wander worktree repair`
3. `fj repo rename mase/explorer wander`
4. Edit `/var/lib/forgejo/repos/mase/wander.git/hooks/post-receive.d/deploy` — replace both `explorer` literals (the `echo` and the `sudo … forgejo-deploy "explorer"` argument) with `wander`
5. `git -C ~/Projects/wander remote set-url origin forgejo@localhost:mase/wander.git`, and the same in this worktree
6. Postgres, connected to `postgres`, API stopped so nothing holds a connection:
   ```sql
   ALTER DATABASE explorer RENAME TO wander;
   ALTER DATABASE explorer_test RENAME TO wander_test;
   ALTER ROLE explorer RENAME TO wander;
   ```
7. Edit `DATABASE_URL` in `~/Projects/wander/server/.env` **and** in this worktree's copy (Helm copies prod's `.env` into every worktree; a stale one sends `server/`'s tests at a database that no longer exists)
8. `sudo usermod -l wander explorer && sudo groupmod -n wander explorer`
9. `sudo cp deploy/wander-api.service /etc/systemd/system/`, `sudo systemctl daemon-reload`, `sudo systemctl disable --now explorer-api`, `sudo rm /etc/systemd/system/explorer-api.service`, `sudo systemctl daemon-reload`, `sudo systemctl enable --now wander-api`

**Verification:**
```
systemctl is-active wander-api
curl -sS https://mase.fi/wander/api/health      # {"status":"ok"} — app.ts:48
curl -sS https://mase.fi/explorer/api/health    # same, via the kept proxy block
psql -lqt | rg wander
git -C ~/Projects/wander worktree list
deploy/check-unit-drift.sh                      # clean — the unit is now installed
```

**Constraints:**
- Step 6 fails loudly if any session holds a connection — that is why step 1 comes first. Check with `SELECT count(*) FROM pg_stat_activity WHERE datname='explorer';` if it refuses.
- `ALTER ROLE … RENAME` clears an **md5** password because the role name is the salt. This role is `SCRAM-SHA-256` (verified against `pg_authid`), so the password survives. Do not "helpfully" reset it.
- `usermod -l` keeps uid 996, so nothing needs re-chowning.

`[Mode: Direct]`

---

## Task 7: shelly

**Contracts:**
1. `systemctl stop wander-junctions`
2. `mv ~/Projects/explorer ~/Projects/wander && mv ~/explorer.git ~/wander.git`
3. Edit `~/wander.git/hooks/post-receive`: `WORK_TREE=/home/shelly/Projects/wander`, `GIT_DIR=/home/shelly/wander.git`
4. Edit `/etc/systemd/system/wander-junctions.service`: `WorkingDirectory` and `BindReadOnlyPaths` → `/home/shelly/Projects/wander/junctions-cache`
5. `systemctl daemon-reload && systemctl start wander-junctions`
6. On the VPS: `git -C ~/Projects/wander remote set-url shelly ssh://shelly/home/shelly/wander.git`

**Verification:**
```
ssh shelly 'systemctl is-active wander-junctions'
curl -sS https://mase.fi/api/junctions/health
```
Expected: `active`; health reports Overpass freshness and fallback state as before.

**Constraints:** the unit and its `wander-junctions` user are already correctly named — only paths move. Do not rename the unit.

`[Mode: Direct]`

---

## Task 8: Helm database migration

**Contracts:** the Helm project is **not** self-healing — `syncProjects()` only ever inserts a row for an unseen directory name. Left alone, the next sync creates a fresh `wander` row with default settings while `id=4` orphans forever as `missing: true`. There is no `helm project rename` verb.

```sql
BEGIN;
UPDATE projects SET name='wander', path='/home/mase/Projects/wander' WHERE name='explorer';
UPDATE sessions               SET project_dir='wander' WHERE project_dir='explorer';
UPDATE ideas                  SET project='wander' WHERE project='explorer';
UPDATE audit_fix_batch_items  SET project='wander' WHERE project='explorer';
UPDATE audit_runs             SET project='wander' WHERE project='explorer';
UPDATE idea_grind_batch_items SET project='wander' WHERE project='explorer';
UPDATE roadmap_phases         SET project='wander' WHERE project='explorer';
UPDATE gotchas                SET project='wander' WHERE project='explorer';
UPDATE host_size_snapshots    SET parent_key='wander' WHERE parent_key='explorer';
UPDATE host_size_snapshots    SET key = regexp_replace(key, '^explorer(:|$)', 'wander\1')
                              WHERE key ~ '^explorer(:|$)';
UPDATE settings               SET scope='project:wander' WHERE scope='project:explorer';
UPDATE audit_findings         SET file_path='deploy/nginx-wander.conf'
                              WHERE file_path='deploy/nginx-explorer.conf' AND status='open';
COMMIT;
```

**Constraints:**
- `sessions.project_dir` is a **bare slug**, not a path — the filesystem path lives in `worktree_path`. A `LIKE '%/explorer%'` clause matches zero rows.
- `worktree_path`, `plan_path` and `source_plan_path` all point into `~/helm/worktrees/explorer/<id>/`, which this design does not rename and whose worktrees are already deleted. **Leave them.**
- `host_size_snapshots.key` is anchored `^explorer(:|$)` so a future `explorer-*` project is not swept up.
- Only the **open** `audit_findings.file_path` row (#6385) is rewritten; the two `fixed` rows are historical.
- Prose columns — `events.payload` (13,595 rows), `kelo_messages.*`, `sessions.prompt`/`name`/`launch_prompt`, `ideas.details`/`summary`/`title`, `audit_findings.description`/`title`/`suggestion`, `session_analytics.*` — are **not** rewritten. `helm blame` reads the events log; rewriting it corrupts the history it exists to preserve.

**Verification:**
```
helm project show wander
psql -d helm -At -c "SELECT count(*) FROM projects WHERE name='explorer';"   # → 0
```
Then re-run the containment scan from the design's step 5 and confirm every remaining `explorer` hit is a prose column.

`[Mode: Direct]`

---

## Task 9: mase.fi showcase and update history

**Files:** `/var/www/html/updates.json` (252 entries), `~/Projects/mase.fi/src/ascii.js`

**Contracts:**
1. Back up `updates.json`, then rewrite `"project": "explorer"` → `"wander"` across all 252 entries. Leaving them splits the channel and the history vanishes from `wander`.
2. `src/ascii.js`: rename the `explorer:` key to `wander:` (ASCII art, keyed by channel).
3. `helm project set-showcase wander --url https://mase.fi/wander --name Wander --tagline "Round-trip route planning and place discovery"`. The display name is currently the literal `"Explorer"` — this is the split the whole exercise closes.
4. Run `scripts/mase-fi-projects` to regenerate `.projects`.

**Constraints:** Task 8 renames the `settings` scope; step 3 here overwrites its value. Do not call `set-showcase` without Task 8 having run, or the old `project:explorer` scope is left orphaned — the same class of debris as the `projects` row.

**Verification:** the mase.fi homepage shows a **Wander** card linking to `https://mase.fi/wander`, and its channel lists the full 252-entry history.

**Commit (mase.fi repo) after verifying.** `[Mode: Direct]`

---

## Task 10: end-to-end verification

1. `https://mase.fi/wander` and `https://mase.fi/explorer` both load and route a walk
2. An existing `/explorer/<username>#t=<token>` link adopts the account, and the address bar reads `/wander/<username>#t=<token>`
3. A full cloud-backup round-trip — mark a visit, sync, reload, confirm it restored — against the renamed database
4. A real `deploy` from `~/Projects/wander`: service discovered as `wander-api`, webroot updated, `scripts/post-deploy.sh` → `check-unit-drift.sh` clean on both hosts
5. `helm project show wander` reports the real row, with no `explorer` row left flagged `missing`
6. `helm idea list wander` returns the migrated backlog
7. `~/helm/worktrees/explorer/` — once this session is archived and the directory is empty, remove it; Helm creates `worktrees/wander/` for every session after the rename

**Constraints:** use a browser for 1–3, not `curl` — the URL canonicalisation is a `replaceState` and only observable in a real page. Report facts, not impressions.

`[Mode: Direct]`

---

## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A tasks: orchestrator implements directly
- Mode B tasks: dispatched to subagents

Every task is Mode A. There is no creative implementation here — the design fixes the contracts, and the operational tasks are ordered command sequences whose risk is in sequencing, not in code. A subagent would add dispatch overhead and lose the cross-task context that makes the ordering safe.

**Tasks 1–5 are independently shippable.** After Task 5 both URLs serve, the app canonicalises to `/wander`, and the host layer is still entirely named `explorer` with nothing broken — a natural stopping point if the cutover needs to wait.
