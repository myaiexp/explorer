# Public OSRM Fallback + Smart-Routing Toggle Removal — Implementation Plan

**Goal:** Keep Wander producing real walking routes while shelly is offline, by falling back to the public FOSSGIS OSRM server in a reduced, fair-use-paced mode — then retire the smart-routing toggle.

**Architecture:** Two independent layers. Layer 1 lives entirely inside `osrm.js`: every OSRM helper transparently retries against the public server when self-hosted fails, and every public request passes through a serialized ≥1.1 s queue — so fair-use compliance never depends on caller wiring. Layer 2 is an ordinary `degraded` mode flag threaded from `readRouteBuildOptions` down through `destination-resolve.js`, matching the existing `smartRouting`/`winterMode` convention; it only ever reduces work.

**Tech Stack:** Vanilla ES5-style browser JS, no build step. Vitest + jsdom/node via `tests/helpers/load.js`.

Design: `docs/plans/2026-08-29-public-osrm-fallback-design.md`

---

## File Structure

| File | Change |
| --- | --- |
| `osrm.js` | public URL constants, latch, throttle queue, fallback inside `tryOsrm`/`tryNearest`/table fn; `buildLoop` honours `degraded` |
| `route-view.js` | `readRouteBuildOptions` gains `degraded`; `updateDurationBadges` stops asserting a walk on the straight-line path |
| `destination-resolve.js` | `degraded` → plain-loop branch + `retryBudget = 1` |
| `route-dispatch.js` | thread `degraded` |
| `generate.js` | degraded toast (once per page load); straight-line warning |
| `tests/osrm-fallback.test.js` | **new** — layer 1 |
| existing tests | extended per task |

---

### Task 1: Layer 1 — public endpoint fallback + fair-use throttle

**Files:**
- Modify: `osrm.js`
- Modify: `tests/osrm.test.js` — **not optional, see Constraints**
- Test: `tests/osrm-fallback.test.js` (create)

**Contracts:**

```js
// New constants, alongside the existing OSRM_FI_* ones.
const OSRM_PUBLIC_BASE    = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const OSRM_PUBLIC_NEAREST = 'https://routing.openstreetmap.de/routed-foot/nearest/v1/foot';
const OSRM_PUBLIC_TABLE   = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot';

const SELF_HOSTED_RETRY_MS = 5 * 60 * 1000;  // latch lifetime
const PUBLIC_MIN_GAP_MS    = 1100;           // >= FOSSGIS ~1 req/sec fair use

isSelfHostedDown(): boolean          // true while the latch is live
resetOsrmFallbackState(): void       // test seam — clears latch + queue
```

`tryOsrm` / `tryNearest` currently receive a **fully composed URL** (`osrm.js:42`,
`osrm.js:59`). They must instead receive the **path+query suffix** so they can compose
either base themselves. Update their call sites accordingly — this is the change that
makes the fallback internal and invisible to every caller.

**Behaviour:**

| Situation | Result |
| --- | --- |
| self-hosted resolves 2xx with usable geometry | return it; latch untouched |
| self-hosted `fetch` throws (timeout/network) | latch for 5 min, retry same request on public |
| self-hosted `!res.ok` (502/504) | latch for 5 min, retry same request on public |
| self-hosted 200 but no routes / empty geometry | return `null`, **do not latch** — a genuine no-route is a property of the destination, not the backend |
| latch live | skip self-hosted entirely, go straight to public |
| latch expired | next call re-probes self-hosted |
| any public request | serialized, ≥ `PUBLIC_MIN_GAP_MS` apart |

The table helper (`osrm.js:78-84`) **throws** rather than returning null. It gets the
same fallback, but keeps throwing if the public attempt also fails — its caller
(screening) relies on that.

**Test Cases:**

```js
test('uses the self-hosted base while healthy', async () => {
    // fetch stub resolves a valid route body
    await fetchRouteThrough([A, B]);
    expect(fetchedUrls[0]).toContain('mase.fi/api/osrm-fi');
});

test('a self-hosted network failure retries the same request on public', async () => {
    // first call rejects, second resolves a valid route
    const r = await fetchRouteThrough([A, B]);
    expect(fetchedUrls[0]).toContain('mase.fi/api/osrm-fi');
    expect(fetchedUrls[1]).toContain('routing.openstreetmap.de/routed-foot');
    expect(r.coords.length).toBeGreaterThan(0);
});

test('a 502 from self-hosted also falls through to public', async () => { ... });

test('a 200 with no routes returns null and does NOT latch', async () => {
    const r = await fetchRouteThrough([A, B]);
    expect(r).toBeNull();
    expect(isSelfHostedDown()).toBe(false);
    // and the public server was never asked
    expect(fetchedUrls.some(u => u.includes('routing.openstreetmap.de'))).toBe(false);
});

test('while latched, self-hosted is not retried at all', async () => {
    // trip the latch, then issue a second route
    expect(fetchedUrls.filter(u => u.includes('osrm-fi'))).toHaveLength(1);
});

test('the latch expires so a recovered backend is used again', async () => {
    // vi.useFakeTimers, advance past SELF_HOSTED_RETRY_MS
    expect(fetchedUrls.at(-1)).toContain('mase.fi/api/osrm-fi');
});

test('consecutive public requests are at least PUBLIC_MIN_GAP_MS apart', async () => {
    // fake timers; assert the second fetch has not fired before the gap elapses
});

test('the table helper falls back to public and still throws if both fail', async () => { ... });
```

**Constraints:**
- Module-scoped mutable state is acceptable here — `withLoading` (`loading.js`) is the
  one-build-at-a-time mutex, so exactly one build is ever in flight. **Say so in a
  comment at the latch**; it is the assumption that makes this correct.
- `osrm.js` has no `sleep`; `overpass.js`'s is not a dependency of `osrm`
  (`tests/helpers/load.js:62`). Add a local one rather than widening `SCRIPT_DEPS`.
- Do not change `FETCH_TIMEOUT_MS`.
- **The latch bleeds across `tests/osrm.test.js` and will break passing tests.** That
  file calls `loadScripts('osrm')` once in a file-level `beforeAll` (`:19`) and its
  `afterEach` (`:22-25`) only restores mocks — module state survives every test. Two of
  its existing tests deliberately trip exactly the conditions that now latch:
  `'returns null when fetch throws'` (`:121`) and `'returns null on a non-ok response'`
  (`:126`). Once latched, later tests asserting a self-hosted URL fail — e.g.
  `buildOneWay`'s `expect(url.startsWith(OSRM_FI_BASE))` (`:348`). Add
  `beforeEach(() => resetOsrmFallbackState())` to that file. Without this the
  implementer sees unrelated-looking failures in tests they never touched.
- **That file's `describe('tryOsrm')` block (`:103-166`) calls `globalThis.tryOsrm(url)`
  with a fully-composed URL** — the old contract. Its fetch mocks are
  URL-insensitive, so some assertions would keep passing by accident; that is not
  compatibility. Rewrite the block to the new suffix contract rather than letting it
  survive by coincidence.
- `loop-vias.test.js` also loads `osrm` but exercises only pure geometry (no fetches),
  so it needs no change. `corridor-junctions.test.js` extracts function source rather
  than sharing the module realm — likewise unaffected.

**Verification:** `build-lock npx vitest run tests/osrm-fallback.test.js tests/osrm.test.js`

**Commit after passing.** `[Mode: Delegated]`

---

### Task 2: Layer 2 — degraded pipeline reduction

**Files:**
- Modify: `route-view.js`, `osrm.js`, `destination-resolve.js`, `route-dispatch.js`
- Test: `tests/route-view.test.js`, `tests/osrm.test.js`, `tests/destination-resolve.test.js`, `tests/route-dispatch.test.js`

**Contracts:**

```js
readRouteBuildOptions(tripMode) -> { tripMode, smartRouting, winterMode, maxKm, spread, degraded }
// degraded === isSelfHostedDown()

buildLoop(startLat, startLng, destLat, destLng, spread, { degraded = false } = {})
// degraded: use the geometric vias as-is; issue no snapToRoad/nearest calls

buildRouteForDestination({ ..., degraded })
// degraded short-circuits BEFORE the `tripMode !== 'one-way' && smartRouting` check
// (destination-resolve.js:209) and goes straight to the single-shot plain-loop branch.
// So findBestLoop and buildJunctionLoop are never entered at all when degraded —
// "retryBudget = 1" describes the resulting behaviour, not a second mechanism.
```

**Test Cases:**

```js
test('readRouteBuildOptions reports degraded when the latch is live', () => { ... });

test('a degraded buildLoop issues no nearest calls', async () => {
    await buildLoop(60, 24, 60.1, 24.1, SPREAD(), { degraded: true });
    expect(fetchedUrls.filter(u => u.includes('/nearest/'))).toHaveLength(0);
});

test('a non-degraded buildLoop still snaps its vias', async () => {
    expect(fetchedUrls.filter(u => u.includes('/nearest/'))).toHaveLength(6);
});

test('a degraded round trip issues exactly 2 route calls', async () => { ... });

test('degraded skips the junctions path even for a round trip', async () => {
    expect(fetchedUrls.some(u => u.includes('/api/junctions/'))).toBe(false);
});

test('degraded caps the candidate retry budget at 1', async () => {
    // pool of 3 candidates, all degenerate → still only one build attempt
});
```

**Constraints:**
- `degraded` is passed in, never read from the DOM inside `destination-resolve.js` —
  its header (`destination-resolve.js:5`) states that convention explicitly.
- Layer 2 must not be load-bearing for fair use. Task 1's throttle already guarantees
  it; nothing here may assume otherwise.

**Verification:** `build-lock npx vitest run tests/route-view.test.js tests/osrm.test.js tests/destination-resolve.test.js tests/route-dispatch.test.js`

**Commit after passing.** `[Mode: Delegated]`

---

### Task 3: Tell the user — degraded toast + honest straight-line badges

**Files:**
- Modify: `generate.js`, `route-view.js`
- Test: `tests/generate.test.js`, `tests/route-view.test.js`

**Contracts:**
- On the first build of a page load that runs degraded, `showWarning` once: routing
  backend is down, using the public server, results and speed are worse. Subsequent
  degraded builds stay silent.
- When a build produces no outbound coords, `showWarning` that the dashed line is a
  straight-line placeholder, not a walking route. (This is the existing silent
  `fallbackStraight` path — `generate.js:85` already declines to persist it.)
- `updateDurationBadges` gains a "no real route" case: the distance badge is labelled
  as straight-line, and the bike/car badges hide. Both directions must be set, so a
  later successful route restores them — see the stateful-line rule.

**Test Cases:**

```js
test('warns once per page load when a build runs degraded', async () => {
    await generateDestination(); await generateDestination();
    expect(warnings.filter(w => /public/i.test(w))).toHaveLength(1);
});

test('warns that the dashed line is not a walking route when no route was built', async () => { ... });

test('does not warn about the straight line when a route was built', async () => { ... });

test('the distance badge is labelled straight-line when there is no route', () => {
    expect(document.getElementById('distanceBadge').textContent).toMatch(/straight/i);
});

test('bike and car badges hide when there is no route', () => { ... });

test('a later successful route restores the bike and car badges', () => { ... });
```

**Constraints:**
- Do **not** change `computeRouteTotals` (`session.js:19`). Its straight-line
  substitution is still wanted for a *partial* result; the badge honesty fix belongs at
  the render boundary. Idea #3807 tracks the partial case separately.

**Verification:** `build-lock npx vitest run tests/generate.test.js tests/route-view.test.js`

**Commit after passing.** `[Mode: Direct]`

---

### Task 4: Part 2 — make smart routing unconditional, delete the toggle

**Do not start before Tasks 1–3 are committed.**

**Files:**
- Modify: `route-view.js` (**first**), `index.html`, `destination-resolve.js`,
  `route-dispatch.js`, `generate.js`, `spread-control.js`, `route-restore.js`, `settings.js`
- Test: `tests/route-view.test.js`, `tests/settings.test.js`, `tests/route-dispatch.test.js`,
  `tests/generate.test.js`, `tests/destination-resolve.test.js`, `tests/spread-control.test.js`,
  `tests/route-restore.test.js`, `tests/app.test.js`

**Contracts:**
- `readRouteBuildOptions` no longer touches `#smartRouting`; round trips are smart by
  definition, one-way is unaffected (it was never smart).
- `buildRouteForDestination` drops its `smartRouting` gate (`destination-resolve.js:209`).
  Its `:219` call currently passes `smartRouting: false` to mean *plain loop* — that
  meaning must survive as something explicit, not be deleted along with the flag.
- `buildRouteForMode`'s two branches collapse.
- `settings.js` — **delete the `{ key: 'smartRouting', id: 'smartRouting', prop:
  'checked' }` entry from `SETTINGS_FIELDS` (`:20`)**. That one declarative array drives
  `saveSettings`, `restoreSettings` *and* `initSettingsListeners`, and the last does
  `document.getElementById(f.id).addEventListener(...)` for every entry unconditionally
  (`:62-64`). Leaving the entry while the element is gone throws at **app bootstrap** —
  a blank page on every load, strictly worse than the `readRouteBuildOptions` breakage.
  Previously stored values are then ignored harmlessly.

**Test Cases:**

```js
test('readRouteBuildOptions works with no #smartRouting element in the DOM', () => {
    document.getElementById('smartRouting')?.remove();
    expect(() => readRouteBuildOptions('round')).not.toThrow();
});

test('a spread reroute works with no #smartRouting element', async () => { ... });
test('a shared-link restore works with no #smartRouting element', async () => { ... });

test('app bootstrap survives with no #smartRouting element', () => {
    // the SETTINGS_FIELDS landmine: initSettingsListeners iterates the array and
    // addEventListener's every entry, so a stale entry blanks the page on load
    document.getElementById('smartRouting')?.remove();
    expect(() => initSettingsListeners()).not.toThrow();
    expect(() => saveSettings()).not.toThrow();
    expect(() => restoreSettings()).not.toThrow();
});

test('a round-trip generate still takes the multi-candidate path', async () => {
    // guards the silent downgrade to single-shot buildLoop
});

test('one-way builds are unchanged', async () => { ... });

test('no smartRouting reference survives', () => {
    // grep index.html + repo-root .js for /smartRouting/
});
```

**Constraints:**
- `route-view.js` must be fixed in the same commit as the `index.html` deletion, or
  every build/reroute/restore throws `TypeError: null.checked`.
- Degraded mode (Task 2) still skips junctions; the two must compose.

**Verification:** `build-lock npx vitest run tests/` then full `test-suite`.

**Commit after passing.** `[Mode: Delegated]`

---

## Execution
**Skill:** Subagent Dev
- Mode A tasks: orchestrator implements directly
- Mode B tasks: Dispatched to subagents
