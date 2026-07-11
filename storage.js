// localStorage accessors — the array-backed collections (visits, saved
// locations, favorites, history) and their storage keys. No DOM, no network.
// Loaded before app.js; the keys are used by app.js's setItem/sync calls too,
// so they live here once and are exposed as globals.

const VISITS_KEY = 'walk_visits';
const SAVED_LOCATIONS_KEY = 'walk_saved_locations';
const FAVORITES_KEY = 'walk_favorites';
const HISTORY_KEY = 'walk_history';

// Parse a JSON array from localStorage, returning [] on missing/corrupt data.
// Shared by every array-backed accessor so the parse-or-default contract lives
// in exactly one place.
function readStoredArray(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
        return [];
    }
}

// Serialize an array back to localStorage — the write-side counterpart to
// readStoredArray, so the JSON.stringify/setItem pairing lives in one place.
// The cloud-mirror half (ExplorerSync.mutate) stays in app.js's syncedPut/
// syncedDelete, which wrap this — storage.js itself does no network.
function writeStoredArray(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr));
}

function getVisits() {
    return readStoredArray(VISITS_KEY);
}

function getSavedLocations() {
    return readStoredArray(SAVED_LOCATIONS_KEY);
}

function getFavorites() {
    return readStoredArray(FAVORITES_KEY);
}

function getHistory() {
    return readStoredArray(HISTORY_KEY);
}

// Explicit globalThis exports — app.js references these keys and accessors as
// globals, and the vm-based tests read them off globalThis.
globalThis.VISITS_KEY = VISITS_KEY;
globalThis.SAVED_LOCATIONS_KEY = SAVED_LOCATIONS_KEY;
globalThis.FAVORITES_KEY = FAVORITES_KEY;
globalThis.HISTORY_KEY = HISTORY_KEY;
globalThis.readStoredArray = readStoredArray;
globalThis.writeStoredArray = writeStoredArray;
globalThis.getVisits = getVisits;
globalThis.getSavedLocations = getSavedLocations;
globalThis.getFavorites = getFavorites;
globalThis.getHistory = getHistory;
