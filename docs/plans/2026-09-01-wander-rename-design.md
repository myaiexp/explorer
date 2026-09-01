# Renaming explorer → wander

**Date:** 2026-09-01
**Status:** approved, not yet implemented

The app has called itself **Wander** in the UI since it was built (`<title>`, the
brand span). Every layer underneath it is still called `explorer`: the Forgejo
repo, the checkout directory, the Helm project, the systemd unit, the system
user, the webroot, three Postgres objects, both shelly paths, and the public URL.
The split costs a sentence of translation every time the project is discussed.

This design closes it. One name, `wander`, everywhere — with the single
exception that **both public URLs keep serving**, because `/explorer/<username>`
is how a cloud-backup bearer token travels between devices and those links have
to keep working forever.

## Scope

661 in-repo mentions across ~70 files, plus host-level state on two machines,
plus rows in two databases, plus three repositories.

| Layer | Now | After |
|---|---|---|
| Forgejo repo | `mase/explorer.git` | `mase/wander.git` |
| Main checkout | `~/Projects/explorer` | `~/Projects/wander` |
| Helm project | `explorer` | `wander` |
| systemd (VPS) | `explorer-api.service` | `wander-api.service` |
| System user | `explorer` (uid 996) | `wander` (uid 996, unchanged) |
| Webroot | `/var/www/html/explorer` | `/var/www/html/wander` |
| Postgres db | `explorer`, `explorer_test` | `wander`, `wander_test` |
| Postgres role | `explorer` | `wander` |
| shelly checkout | `~/Projects/explorer` | `~/Projects/wander` |
| shelly bare repo | `~/explorer.git` | `~/wander.git` |
| npm package | `explorer-api` | `wander-api` |
| DOM event | `explorer-sync-state-change` | `wander-sync-state-change` |
| JS globals | `window.ExplorerSync`, `window.ExplorerSyncUI` | `window.WanderSync`, `window.WanderSyncUI` |
| Public URL | `/explorer` | `/wander` **and** `/explorer`, both live |

### Deliberately not renamed

- **`docs/plans/`** — 156 of the 661 mentions. These are records of what was
  built and when. Rewriting them makes them lie about history. They stay.
- **`~/helm/worktrees/explorer/`** — the only live worktree there is the session
  doing this work. It drains on archive, and Helm creates `worktrees/wander/`
  from then on. Renaming a directory a session is running inside is the one
  genuinely unsafe move available here, and it buys nothing.
- **uid 996** — `usermod -l` renames the login without touching the uid, so no
  file on either machine needs re-chowning.
- **The Helm events log and every other prose column** — `events.payload` alone
  holds 13,595 rows containing the string. These describe what happened under
  the name it had at the time; `helm blame` reads them. Enumerated in step 5.

## Component 1 — the dual URL

Both prefixes serve the same SPA from the same webroot; both `/explorer/api/`
and `/wander/api/` proxy to `127.0.0.1:3700`. The app **reads either prefix and
writes only `/wander/`**, so an old link works forever and the address bar
canonicalises to the new name on arrival.

Three frontend sites change:

| File | Now | After |
|---|---|---|
| `sync.js` | `API_BASE = '/explorer/api'` | `API_BASE = '/wander/api'` |
| `sync-init.js:41` | `/\/explorer\/([^/?#]+)/` | `/\/(?:explorer\|wander)\/([^/?#]+)/` |
| `sync.js:183,245,270`, `sync-init.js:230,250` | writes `/explorer/…` | writes `/wander/…` |

`API_BASE` stays a single absolute constant rather than being derived from
`location.pathname`. A page served at `/explorer/…` calling `/wander/api` is
same-origin, so the existing CSP `connect-src 'self'` already permits it, and
one constant cannot drift out of sync with the page it was loaded by. The
`/explorer/api/` proxy block is kept anyway — for pages loaded before the
cutover, and because it costs six lines.

### The CSP-drift hazard

nginx `add_header` is all-or-nothing per context: a location with its own
`add_header` inherits **none** from server level. That is why the current
`/explorer` block re-lists every security header plus a Wander-scoped CSP
(finding #7059). Two static blocks would mean two copies of that CSP, and a CSP
that drifts between them is a silent hole — the weaker block wins for anyone
using it, with no error anywhere.

So the shared header set moves into an include:

- `deploy/nginx-wander-headers.conf` → installed at
  `/etc/nginx/snippets/wander-headers.conf`
- `deploy/nginx-wander.conf` carries both `location /wander` and
  `location /explorer`, each `include`-ing the snippet, differing only in
  `try_files`. Both `alias /var/www/html/wander`.

`/etc/nginx/snippets/` already exists on the box and is already used
(`fastcgi-php.conf`, `snakeoil.conf`), so this introduces no new mechanism.

`tests/nginx-security.test.js` currently slices the committed file on
`location /explorer\s*\{` and asserts against that one block. It is rewritten
to assert the header/CSP contract against the snippet once, and to assert that
**both** location blocks include it — which is what actually prevents the drift.

Four separate `describe` blocks in that file call
`readDeploy('nginx-explorer.conf')`, and **all four** break the moment the file
is renamed — not just the header one:

| Line | Block | Asserts |
|---|---|---|
| 33 | `nginx-explorer.conf (finding #7059)` | headers + CSP on the static block |
| 118 | `nginx-explorer.conf API proxy (finding #7582)` | the `/explorer/api/` proxy pin |
| 144 | img-src derivation | CSP `img-src` covers every host in `map-view.js` |
| 192 | connect-src derivation | CSP `connect-src` covers every fetched host |

The img-src and connect-src blocks derive their expectations from the frontend
sources, so they keep working unchanged once pointed at the snippet. The proxy
block needs to pin **both** API locations.

## Component 2 — the coupling

Four separate things key off one string, and a rename that flips some but not
all of them breaks deploys silently rather than loudly:

- `deploy` derives `$PROJECT` from the checkout directory name
- `deploy` discovers the unit by globbing `${project}*.service`, then filters
  with `service_matches_project` — exact match or `$project-*`, so `wander`
  finds `wander-api` (verified in `deploy-lib/services.sh`)
- `forgejo-deploy` branches on `case "$REPO"`, whose paths
  (`$PROJECTS/explorer`, `$FORGEJO_REPOS/explorer.git`,
  `WEB_DIR=/var/www/html/explorer`) are all hardcoded literals
- `$REPO` itself is a **hardcoded literal** in each bare repo's
  `hooks/post-receive.d/deploy`, which passes `"explorer"` to the dispatcher and
  does **not** follow a Forgejo rename

So: forgejo repo name = the literal in the post-receive hook = the `case` label
= checkout dir name = unit prefix. All five, or deploys wedge.

The `/tmp/forgejo-deploy-${PROJECT}.done` marker is **not** part of this
coupling for this project. Only the `central-hub)` case writes a marker, and
`deploy` decides whether to wait by grepping `forgejo-deploy`'s own source for
that literal path — which is false here. `deploy` restarts `explorer-api`
itself, locally, exactly as `deploy/README.md` says. Nothing in the `explorer)`
case touches a marker; it ends with `echo "✓ Built explorer @ $SHORT_SHA
(restart via deploy)"`.

Rather than make that a knife-edge atomic swap, `forgejo-deploy` is made
name-agnostic **first**, as its own change: the branch becomes `explorer|wander)`
with `$PROJECTS/$REPO` and `$FORGEJO_REPOS/$REPO.git` derived from `$REPO`
instead of hardcoded. It is then correct before, during and after the flip, and
the ordering stops being critical. `WEB_DIR` is the deliberate exception — it is
pinned to `/var/www/html/wander` rather than derived, for the reason given in
step 0.

That is a **helm** repo change. `/usr/local/bin/forgejo-deploy` is a symlink to
`~/Projects/helm/scripts/forgejo-deploy`, so it goes live the moment helm lands
on master — no install step, but also no staging: it must be landed
deliberately, not left sitting in a worktree.

Helm's scripts mention `explorer` in nine places, but eight are comments
recording past incidents (`build-lock`, `deploy-lib/push.sh`,
`test-suite-lib/*`, and three test files) and stay as written, for the same
reason `docs/plans/` does. Exactly two helm edits are functional:

1. `scripts/forgejo-deploy` — the `case` branch, made name-agnostic
2. `scripts/check-cache-headers.sh:37` — `https://mase.fi/explorer/` in the
   checked-URL list, re-pointed at `/wander/`

The rename therefore spans **three repos** — wander, helm, mase.fi — two
machines, root-owned files that nothing tracks (nginx vhost, systemd units, the
post-receive hook), and two untracked `.env` files.

## Component 3 — cutover sequence

Ordered so that the site is serving correctly at every point between steps, and
so the only interruption is one short window in step 3.

**Step 0 — helm.** `forgejo-deploy`'s branch becomes `explorer|wander)` with
`$PROJECTS/$REPO` and `$FORGEJO_REPOS/$REPO.git` derived from `$REPO`, but
`WEB_DIR` **pinned to the new `/var/www/html/wander`** regardless of which name
triggered it. Deriving `WEB_DIR` from `$REPO` too would chain the webroot move to
the Forgejo rename and force both into the same window; pinning it decouples
them, so the webroot can move in step 1 while the repo is still called
`explorer`. Plus `scripts/check-cache-headers.sh`. Commit and deploy helm.

**Step 1 — webroot and nginx (VPS, zero downtime).** `mv /var/www/html/explorer
/var/www/html/wander` — an atomic rename of static files, with no reader
interrupted. Install the headers snippet; re-point the existing `/explorer`
block's `alias` at the new directory; add the `/wander` and `/wander/api/`
blocks; `nginx -t`; reload. Both URLs now serve the current app, and the
committed `deploy/nginx-wander.conf` is final-state from this point on rather
than carrying a temporary alias that a later step has to revisit.

**Step 2 — wander repo.** Every in-repo rename: package name, the DOM event, the
`window.ExplorerSync` / `ExplorerSyncUI` globals (~195 occurrences across 21
files — the same class of purely-internal identifier as the event, and renaming
one without the other leaves the rename half-adopted), the URL sites, the
`deploy/nginx-explorer.conf` → `nginx-wander.conf` + snippet split, and the
prose in `CLAUDE.md`, `deploy/README.md`, `server/README.md`, `tests/README.md`.
Commit, `deploy`, verify both URLs in a browser. **The host layer is still
entirely `explorer` at this point and everything works** — this step is
independently shippable.

The systemd unit file is the deliberate exception: it renames in step 3, with
its install, for the `check-unit-drift.sh` reason under Error handling. Grep
case-insensitively when checking the sweep — `rg -l explorer` is what let the
capitalised globals hide through an entire draft of the plan.

**Step 3 — the flip window (VPS, API down ~2 min).**

1. `systemctl stop explorer-api`
2. `mv ~/Projects/explorer ~/Projects/wander`, then
   `git -C ~/Projects/wander worktree repair` — moving the main checkout leaves
   every linked worktree's `.git` file pointing at the old path; `repair` is what
   fixes them
3. `fj repo rename mase/explorer wander`
4. Edit the bare repo's `hooks/post-receive.d/deploy` — it passes the literal
   `"explorer"` to `forgejo-deploy` and does not follow the rename
5. Update `origin` in the main checkout and in this worktree
6. Postgres, connected to another database, with the API stopped so no session
   holds a connection:
   `ALTER DATABASE explorer RENAME TO wander;`
   `ALTER DATABASE explorer_test RENAME TO wander_test;`
   `ALTER ROLE explorer RENAME TO wander;`
7. Edit `~/Projects/wander/server/.env` `DATABASE_URL` (untracked; does not
   travel with the repo) and this worktree's copy
8. `usermod -l wander explorer && groupmod -n wander explorer`
9. Install `wander-api.service`, `daemon-reload`, `disable --now explorer-api`,
   remove the old unit file, `enable --now wander-api`
10. Health check

Postgres note: renaming a role clears an **md5** password, because the role name
is the salt. `pg_authid.rolpassword` for `explorer` begins `SCRAM-`, and
`pg_hba.conf` is `scram-sha-256` throughout, so the password survives the rename.
This was verified, not assumed.

**Step 4 — shelly.** Stop `wander-junctions`; `mv ~/Projects/explorer
~/Projects/wander`; `mv ~/explorer.git ~/wander.git`; edit the post-receive
hook's `WORK_TREE` and `GIT_DIR`; edit the unit's `WorkingDirectory` and
`BindReadOnlyPaths`; `daemon-reload`; start. Update the `shelly` remote URL in
the main checkout. The unit and its `wander-junctions` user are already correctly
named — only the paths move.

**Step 5 — helm data.** The Helm project is **not** self-healing. `syncProjects()`
(`helm/src/db/projects.ts`, run at boot and on every `GET /api/projects`) reads
the directory listing and inserts a row for any name it hasn't seen — it never
updates a row whose path changed, and never deletes one whose path vanished. So
after step 3's `mv`, the next sync silently creates a fresh `wander` row with
**default** settings while the real row (`id=4`) orphans forever, flagged
`missing: true`. There is no `helm project rename` verb. This is a required SQL
migration, not a consequence of the directory move.

The surface was established by scanning every `text`/`varchar`/`jsonb` column in
the `helm` database for the string, not by guessing at column names — an
equality scan keyed on columns named `project` misses `projects.name`,
`settings.scope` and the `explorer:*` composite keys, all of which are
load-bearing.

**Identity — rename these:**

| Table.column | Shape |
|---|---|
| `projects.name`, `projects.path` | `id=4`; the row that would otherwise orphan |
| `sessions.project_dir` | bare slug `'explorer'`, **not** a path |
| `ideas.project` | |
| `audit_fix_batch_items.project` | |
| `audit_runs.project` | carries `audit_findings` by FK |
| `idea_grind_batch_items.project` | |
| `roadmap_phases.project` | |
| `gotchas.project` | |
| `host_size_snapshots.key` | `'explorer'` and `'explorer:<file>'` — anchor on `^explorer(:\|$)` so a future `explorer-*` project is not caught |
| `host_size_snapshots.parent_key` | `'explorer'` |
| `settings.scope` | `'project:explorer'` → `'project:wander'` (the showcase row — see step 6) |
| `audit_findings.file_path` | **only the one open finding**, #6385, pointing at `deploy/nginx-explorer.conf` |

`sessions.project_dir` is a bare slug for every row including this session's, so
it is a flat `WHERE project_dir='explorer'` with no exclusion. Row counts are
deliberately not quoted as operational values — they drift (filing idea #4049
during this design moved `ideas` from 88 to 89), and every statement is a
blanket `WHERE`, not count-driven.

**Prose and dead paths — leave alone:**

`events.payload` (13,595 rows), `kelo_messages.*`, `sessions.prompt` / `name` /
`launch_prompt`, `ideas.details` / `summary` / `title`,
`audit_findings.description` / `title` / `suggestion`, `session_analytics.*`.
These record what happened at the time, under the name it had then; `helm blame`
reads the events log and rewriting it would corrupt the history it exists to
preserve. Same rule as `docs/plans/`.

`sessions.worktree_path`, `plan_path` and `source_plan_path` all point into
`~/helm/worktrees/explorer/<id>/` — worktrees that are already deleted, in a
directory this design deliberately does not rename. Rewriting them would not
make them any more valid. The two **fixed** `audit_findings.file_path` rows are
historical for the same reason; only the open one is rewritten.

**Step 6 — mase.fi.** `/var/www/html/updates.json` holds 252 entries with
`"project": "explorer"`; the showcase channel is the Helm project name, so
leaving them makes the channel split in two and the history vanish from the
`wander` channel. Rewrite the field in place, after a backup. Rename the
`explorer:` key in `src/ascii.js` (project ASCII art, keyed by channel).

The showcase itself is the `settings` row renamed in step 5 —
`scope='project:explorer'`, `key='showcase'`, holding
`{"url": "https://mase.fi/explorer", "name": "Explorer", "tagline": …}`. Note
the display name on the homepage is currently the literal string **"Explorer"**,
which is the naming split this whole exercise exists to close. Running
`helm project set-showcase wander --url https://mase.fi/wander --name Wander
--tagline "Round-trip route planning and place discovery"` writes the correct
row; the stale `project:explorer` scope must then be deleted, or renamed in step
5 and left for `set-showcase` to overwrite. Do not simply call `set-showcase` on
the new name and walk away — that leaves the old scope orphaned, the same class
of debris as the `projects` row. Finally regenerate with
`scripts/mase-fi-projects`.

**Step 7 — verification.** See below.

## Error handling and rollback

Every step is a rename, so every step reverses. The failure modes worth naming:

- **DB rename blocked by an open connection.** `ALTER DATABASE` fails outright if
  any session is connected — loud, not silent. The API is stopped first; if it
  still fails, a stray `psql` is the cause.
- **The stale `.env` in this worktree.** Helm copies the production `.env` into
  every worktree, so this worktree holds a `DATABASE_URL` naming `explorer`.
  After step 3 it points at a database that no longer exists, and
  `server/tests/test-db.ts` derives the test DB by suffixing that name — so
  `cd server && pnpm test` starts looking for `explorer_test`. This worktree's
  `.env` needs the same edit as the VPS one. Worktrees created after the flip
  inherit the corrected file.
- **Deploy wedged between steps.** Step 0 removes this failure mode by making
  `forgejo-deploy` accept both names; without it, any deploy attempted between
  the directory rename and the hook edit would hit no `case` branch and exit
  silently having pushed but built nothing.
- **A deploy that fails *after* succeeding.** `scripts/post-deploy.sh` is
  `exec deploy/check-unit-drift.sh`, which matches `deploy/<name>.service`
  against `/etc/systemd/system/<name>.service` **by exact filename** and exits 1
  on MISSING. So renaming `deploy/explorer-api.service` in the repo any earlier
  than the step that installs the new unit makes every `deploy` report failure —
  after the build, restart and webroot copy have all already succeeded, which is
  the most misleading shape a failure can take. The unit file is therefore
  renamed inside step 3, next to its `systemctl` install, and nowhere earlier.
- **CSP drift between the two location blocks.** Structurally prevented by the
  shared include, and pinned by the rewritten `nginx-security.test.js`.

## Testing

Pinned by the suite:

- `tests/nginx-security.test.js` — header/CSP contract on the snippet; both
  location blocks include it; `img-src` and `connect-src` still derived from
  `map-view.js` and the frontend sources
- `server/tests/wander-api-service.test.ts` — unit isolation contract against the
  renamed unit file (`ProtectHome=tmpfs`, `BindReadOnlyPaths`, the capability set)
- `tests/sync*.test.js` — the URL policy: an `/explorer/<username>` path is still
  read as an account, and every write produces `/wander/`
- `deploy/check-unit-drift.sh` via `scripts/post-deploy.sh` — installed units on
  both machines match the repo copies

Manual, after step 7:

1. Load `https://mase.fi/wander` and `https://mase.fi/explorer` — both serve;
   the second canonicalises the address bar
2. Open an existing `/explorer/<username>#t=<token>` link — the account is
   adopted and the bar reads `/wander/<username>#t=<token>`
3. A full cloud-backup round-trip against the renamed database
4. A real `deploy` from `~/Projects/wander` — service discovered, marker matched,
   webroot updated
5. `helm idea list wander` returns the migrated ideas and `helm project show
   wander` reports the real row — not a freshly-synced default one, and with no
   second `explorer` row left flagged `missing`
6. The mase.fi `wander` channel shows the full 252-entry history, and the
   homepage card reads "Wander"
7. Re-run the containment scan from step 5 and confirm the only remaining
   `explorer` hits are the prose columns it deliberately leaves alone
