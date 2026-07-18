// Settings persistence — save/restore the walk preference form to localStorage.

const SETTINGS_KEY = 'walk_settings';

// Declarative spec for the persisted preferences, so save/restore/listen all
// iterate one list instead of enumerating the same fields three times.
// prop is the element property to read/write; skipEmpty fields (free-text-ish
// inputs) are only restored when non-empty so a blank saved value never clobbers
// a default. The tripMode radio pair and the distance-label sync stay explicit
// in restoreSettings — they don't fit the one-element/one-prop shape.
const SETTINGS_FIELDS = [
    { key: 'location',     id: 'location',           prop: 'value',   skipEmpty: true },
    { key: 'minDistance',  id: 'minDistance',        prop: 'value' },
    { key: 'maxDistance',  id: 'maxDistance',        prop: 'value' },
    { key: 'poiType',      id: 'locationTypeSelect', prop: 'value',   skipEmpty: true },
    { key: 'spread',       id: 'spreadSlider',       prop: 'value' },
    { key: 'winterMode',   id: 'winterMode',         prop: 'checked' },
    { key: 'smartRouting', id: 'smartRouting',       prop: 'checked' },
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

function restoreSettings() {
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
    // Sync distance label with restored trip mode
    const isOneWay = document.getElementById('oneWay').checked;
    document.getElementById('distanceLabel').textContent =
        isOneWay ? 'One-way distance (km)' : 'Round-trip distance (km)';
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
