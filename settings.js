// Settings persistence — save/restore the walk preference form to localStorage.
// restoreSettings calls syncDistanceLabel (route-view.js) at call time — this
// file loads first, but app.js restores after every script has evaluated.

const SETTINGS_KEY = 'walk_settings';

// Declarative spec for the persisted preferences, so save/restore/listen all
// iterate one list instead of enumerating the same fields three times.
// prop is the element property to read/write; skipEmpty fields (free-text-ish
// inputs) are only restored when non-empty so a blank saved value never clobbers
// a default. The tripMode radio pair and the distance-label sync stay explicit
// in restoreSettings — they don't fit the one-element/one-prop shape.
// smartRouting used to live here (a checkbox) — smart routing is no longer a
// user toggle (it is unconditional for round trips; see route-view.js), the
// #smartRouting element is gone, and this array drives initSettingsListeners'
// unconditional getElementById(f.id) below, so a stale entry here throws at
// bootstrap the moment the element disappears. A previously-stored
// smartRouting value in localStorage is simply never read again — no
// migration needed, restoreSettings only ever reads keys still in this list.
const SETTINGS_FIELDS = [
    { key: 'location',     id: 'location',           prop: 'value',   skipEmpty: true },
    { key: 'minDistance',  id: 'minDistance',        prop: 'value' },
    { key: 'maxDistance',  id: 'maxDistance',        prop: 'value' },
    { key: 'poiType',      id: 'locationTypeSelect', prop: 'value',   skipEmpty: true },
    { key: 'spread',       id: 'spreadSlider',       prop: 'value' },
    { key: 'winterMode',   id: 'winterMode',         prop: 'checked' },
    { key: 'avoidBacktracking', id: 'avoidBacktracking', prop: 'checked' },
];

function saveSettings() {
    const settings = {
        tripMode: document.querySelector('input[name="tripMode"]:checked').value,
    };
    for (const f of SETTINGS_FIELDS) {
        settings[f.key] = document.getElementById(f.id)[f.prop];
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// `any POI` replaced `location (anywhere)` as the default destination type.
// Reordering the <select> alone reaches nobody who has used the app: poiType is
// restored with skipEmpty, so an existing saved 'any' survives and nothing
// visibly changes. This rewrites that stored value ONCE.
//
// The flag is what makes it once rather than permanent. Without it, a user who
// reads the new default and deliberately picks "anywhere" back gets overridden
// on their next reload, forever. It is set even when there is nothing to
// migrate — a fresh install that later picks 'any' must not be migrated on the
// following load.
//
// The rewrite is PERSISTED, not applied in memory. Setting the flag while
// leaving 'any' on disk would suppress re-migration against a value that was
// never corrected, so the next untouched reload silently reverts.
const ANY_POI_MIGRATION_KEY = 'walk_migrated_any_poi';

function migrateAnyToAnyPoi() {
    if (localStorage.getItem(ANY_POI_MIGRATION_KEY)) return;
    let settings;
    try {
        settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    } catch {
        // A corrupt blob has nothing to migrate and restoreSettings is about to
        // ignore it anyway. Still mark the migration done, so a value saved
        // after the blob is rewritten is treated as a deliberate choice.
        localStorage.setItem(ANY_POI_MIGRATION_KEY, '1');
        return;
    }
    if (settings && settings.poiType === 'any') {
        settings.poiType = 'any_poi';
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    localStorage.setItem(ANY_POI_MIGRATION_KEY, '1');
}

function restoreSettings() {
    migrateAnyToAnyPoi();
    // Only the parse is guarded — corrupt localStorage JSON is external data we
    // tolerate. The DOM application below runs OUTSIDE the catch so a drifted
    // element id (getElementById → null) throws loudly instead of silently
    // no-op'ing the whole restore behind a guard meant for bad JSON.
    let settings;
    try {
        settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    } catch {
        return;
    }
    if (!settings) return;

    for (const f of SETTINGS_FIELDS) {
        const val = settings[f.key];
        if (val == null) continue;
        if (f.skipEmpty && !val) continue;
        document.getElementById(f.id)[f.prop] = val;
    }
    // Trip mode is a radio pair (two elements, one stored value) — special-cased.
    if (settings.tripMode === 'round' || settings.tripMode === 'one-way') {
        document.getElementById(settings.tripMode === 'one-way' ? 'oneWay' : 'roundTrip').checked = true;
    }
    // Sync distance label with restored trip mode (strings live in route-view.js).
    syncDistanceLabel();
}

// Auto-save on input changes
function initSettingsListeners() {
    for (const f of SETTINGS_FIELDS) {
        document.getElementById(f.id).addEventListener('change', saveSettings);
    }
    document.querySelectorAll('input[name="tripMode"]').forEach(r => r.addEventListener('change', saveSettings));
}

globalThis.saveSettings = saveSettings;
globalThis.restoreSettings = restoreSettings;
globalThis.initSettingsListeners = initSettingsListeners;
globalThis.ANY_POI_MIGRATION_KEY = ANY_POI_MIGRATION_KEY;
