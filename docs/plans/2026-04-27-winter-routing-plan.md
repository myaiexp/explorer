# Winter Routing Implementation Plan

**Goal:** Add an opt-in winter mode that biases smart routing toward plowed roads (residential, tertiary, etc.) and away from forest paths/tracks/footways, by tightening the highway-tag exclusion list in the two Overpass query functions.

**Architecture:** Pure client-side change. Two existing Overpass query functions (`fetchRoadsInCorridor`, `fetchRoadsInRadius`) gain an optional winter-mode parameter that swaps in a stricter `highway!~` filter. A new checkbox in the controls panel exposes the toggle, persisted in `walk_settings`.

**Tech Stack:** Plain JS, no new dependencies. Same stack as the rest of `app.js`.

**Spec:** [docs/plans/2026-04-27-cloud-backup-and-winter-routing-design.md](./2026-04-27-cloud-backup-and-winter-routing-design.md), Subsystem B.

---

## File Structure

No new files. Changes are localized to:

- `app.js` (Overpass query functions, settings persistence, currentSession)
- `index.html` (new checkbox in controls panel)
- `style.css` (only if the existing checkbox styling needs tweaking — likely no change)

---

## Task 1: Winter-mode toggle + filtered Overpass queries  [Mode: Direct]

**Files:**
- Modify: `app.js` (`fetchRoadsInCorridor` ~line 485, `fetchRoadsInRadius` ~line 462, `saveSettings` ~line 88, `restoreSettings` ~line 101, `initSettingsListeners` ~line 126, every `currentSession = { ... }` site)
- Modify: `index.html` (new checkbox near smart-routing toggle in the controls panel)

**Contracts:**

#### Tag filter constants

Define near the existing road-fetch functions:

```js
const HIGHWAY_EXCLUDE_DEFAULT = 'motorway|motorway_link|trunk|trunk_link|service|steps';
const HIGHWAY_EXCLUDE_WINTER  = 'motorway|motorway_link|trunk|trunk_link|service|steps|path|track|footway|bridleway|cycleway|pedestrian';
```

#### Function signature changes

```js
// Before:
async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm, onProgress);
async function fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm, onProgress);

// After (winterMode added as last parameter, defaulted false):
async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm, onProgress, winterMode = false);
async function fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode = false);
```

Inside each, the Overpass query swaps the exclusion list:

```js
const exclude = winterMode ? HIGHWAY_EXCLUDE_WINTER : HIGHWAY_EXCLUDE_DEFAULT;
const query = `
    [out:json][timeout:15];
    way["highway"]["highway"!~"${exclude}"](${bbox});
    out center;
`;
```

#### Caller updates

Both functions are called from `buildSmartLoop` (~line 624) and the road-point destination flow (search for `fetchRoadsInRadius(`). Each call site reads the current winter-mode setting and forwards it:

```js
const winterMode = document.getElementById('winterMode').checked;
const roads = await fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode);
```

#### Settings persistence

`saveSettings` (app.js:88) gains:

```js
winterMode: document.getElementById('winterMode').checked,
```

`restoreSettings` (app.js:101) gains:

```js
if (settings.winterMode != null) document.getElementById('winterMode').checked = settings.winterMode;
```

`initSettingsListeners` (app.js:126) registers the change listener:

```js
document.getElementById('winterMode').addEventListener('change', saveSettings);
```

#### HTML: new checkbox

In the controls panel near the existing `smartRouting` checkbox (search index.html for `smartRouting`), add:

```html
<label class="checkbox-option">
    <input type="checkbox" id="winterMode">
    <span title="Routes prefer plowed roads instead of forest paths and tracks. Useful in winter.">
        Winter mode (avoid forest paths)
    </span>
</label>
```

(Match the existing checkbox markup pattern in the same area — Task implementer should mirror surrounding structure.)

**Test Cases:**

`app.js` has no module system — it's a single global script. Rather than refactoring it for module exports, the test approach is the **fetch-monkey-patch route**: intercept `queryOverpass` (or the `fetch` it uses) inside the test, call `fetchRoadsInCorridor` with each winterMode value, and assert on the captured query string. This avoids touching `app.js` structure for one feature.

```js
// tests/winter-routing.test.js
// Setup: load app.js into a jsdom env (matches Plan A's test approach if Plan A landed first;
// otherwise stand up a minimal vitest+jsdom setup). Stub queryOverpass to capture args.

test('default exclusion list excludes motorway and steps but allows path', async () => {
  let capturedQuery;
  globalThis.queryOverpass = async (q) => { capturedQuery = q; return { elements: [] }; };
  await fetchRoadsInCorridor(60, 25, 60.1, 25.1, 0.5, () => {}, false);
  expect(capturedQuery).toContain('motorway|motorway_link|trunk|trunk_link|service|steps');
  expect(capturedQuery).not.toMatch(/\|path\|/);
});

test('winter exclusion list also excludes path/track/footway', async () => {
  let capturedQuery;
  globalThis.queryOverpass = async (q) => { capturedQuery = q; return { elements: [] }; };
  await fetchRoadsInCorridor(60, 25, 60.1, 25.1, 0.5, () => {}, true);
  expect(capturedQuery).toContain('path');
  expect(capturedQuery).toContain('track');
  expect(capturedQuery).toContain('footway');
  expect(capturedQuery).toContain('bridleway');
  expect(capturedQuery).toContain('cycleway');
});
```

Manual smoke (laxi):

```bash
# 1. Toggle persistence:
#    - Open localhost:8080/, check Winter mode, reload, assert it's still checked
#
# 2. Behavioral diff in a known mixed-terrain area:
#    - Set start to a location near a forest (e.g. test fixture lat/lng)
#    - Generate round-trip with smart routing on, winter mode OFF: capture road point set from Overpass response
#    - Same inputs with winter mode ON: capture road point set
#    - Assert the winter set is a subset and excludes any way with highway=path/track/footway
```

**Constraints:**
- Winter mode has no effect if smart routing is off; the toggle is gated on `useSmartRouting`. Document this in the tooltip if it confuses users (deferred to follow-up if it does).
- `walk_settings` is not synced to cloud (Subsystem A scope decision) — this is correct; winter mode is a per-device preference.
- Known-but-unfixed: OSRM nearest-snap (`fetchNearestRoadSnaps`) can still drift back to forest paths. Documented limitation; addressed in a separate idea (#853 self-hosted OSRM).
- No changes to POI selection in this iteration. POI category filtering is idea #851 (deferred).

**Verification:**
```bash
# If buildOverpassQuery is extracted:
pnpm vitest run tests/winter-routing.test.js
# expect: 2 tests passing

# Manual smoke per scenarios above.
```

**Commit after passing.**

---

## Sequencing

Single task. Independent of Subsystem A; can ship before, after, or alongside.

---

## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A task (1): Opus implements directly
