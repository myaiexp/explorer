// Cloud-backup section data-shaping — read/merge/normalize/write the four synced
// collections between a server payload and localStorage. Pure local-data layer:
// no account/consent state, no network. sync.js composes these; the flush worker
// does not touch them.
//
// Load order: <script src="sync-sections.js"> BEFORE sync.js. The walk_* keys are
// owned by storage.js and resolved off globalThis at call time (storage.js loads
// after us, but is defined before any method here runs), so the key strings keep
// exactly one home and a rename there can't silently fork.

(function () {
    'use strict';

    // The four synced sections, in sync order. These names are the sync
    // vocabulary — they key the server's GET response and the outbox entries. The
    // 'walk_*' localStorage keys they map to are owned by storage.js; sectionKey()
    // resolves each from storage.js's globals.
    var DATA_SECTIONS = ['visits', 'favorites', 'savedLocations', 'history'];

    // Section's localStorage key, resolved from storage.js's globals at call time.
    function sectionKey(section) {
        switch (section) {
            case 'visits': return globalThis.VISITS_KEY;
            case 'favorites': return globalThis.FAVORITES_KEY;
            case 'savedLocations': return globalThis.SAVED_LOCATIONS_KEY;
            case 'history': return globalThis.HISTORY_KEY;
            default: return undefined;
        }
    }

    // Delegates the parse-or-default contract to storage.js's readStoredArray so
    // it lives in exactly one place (corrupt/missing → []).
    function readSection(section) {
        return globalThis.readStoredArray(sectionKey(section));
    }

    function isLocalStorageEmpty() {
        for (var i = 0; i < DATA_SECTIONS.length; i++) {
            var arr = readSection(DATA_SECTIONS[i]);
            if (Array.isArray(arr) && arr.length > 0) { return false; }
        }
        return true;
    }

    // The favorites section is stored server-side as {id, username, payload, updatedAt}
    // where payload is the flat favorite blob; every other section already comes back
    // flat (typed columns). Unwrap favorites to the flat shape the app + renderer read
    // (f.destLat, f.destName, …), preserving id + updatedAt for last-write-wins. Without
    // this a synced-down favorite stays {id, payload:{…}} and crashes the renderer (#2065).
    function normalizeServerRows(section, serverRows) {
        if (section !== 'favorites') { return serverRows; }
        return serverRows.map(function (row) {
            if (!row || typeof row.payload !== 'object' || row.payload === null) { return row; }
            var flat = Object.assign({}, row.payload, { id: row.id });
            if (row.updatedAt !== undefined) { flat.updatedAt = row.updatedAt; }
            return flat;
        });
    }

    function mergeSection(section, serverRows) {
        serverRows = normalizeServerRows(section, serverRows);
        // Last-write-wins by updatedAt per id
        var local = readSection(section);
        var byId = {};
        local.forEach(function (row) { if (row.id) { byId[row.id] = row; } });
        serverRows.forEach(function (row) {
            if (!row.id) { return; }
            var existing = byId[row.id];
            if (!existing) {
                byId[row.id] = row;
            } else {
                var existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
                var rowTs = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
                if (rowTs >= existingTs) { byId[row.id] = row; }
            }
        });
        var merged = Object.keys(byId).map(function (id) { return byId[id]; });
        localStorage.setItem(sectionKey(section), JSON.stringify(merged));
    }

    function populateSection(section, serverRows) {
        localStorage.setItem(sectionKey(section), JSON.stringify(normalizeServerRows(section, serverRows)));
    }

    function wipeSections() {
        DATA_SECTIONS.forEach(function (s) {
            localStorage.removeItem(sectionKey(s));
        });
    }

    globalThis.SyncSections = {
        DATA_SECTIONS: DATA_SECTIONS,
        sectionKey: sectionKey,
        readSection: readSection,
        isLocalStorageEmpty: isLocalStorageEmpty,
        normalizeServerRows: normalizeServerRows,
        mergeSection: mergeSection,
        populateSection: populateSection,
        wipeSections: wipeSections
    };

}());
