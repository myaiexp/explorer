// Cloud-backup section data-shaping — read/merge/normalize/write the four synced
// collections between a server payload and localStorage. Pure local-data layer:
// no account/consent state, no network. sync.js composes these; the flush worker
// does not touch them.
//
// Load order: <script src="sync-sections.js"> BEFORE sync.js. The walk_* keys are
// owned by storage.js and resolved off globalThis at call time (storage.js loads
// after us, but is defined before any method here runs), so the key strings keep
// exactly one home and a rename there can't silently fork. Reads and writes
// delegate to storage.js's readStoredArray/writeStoredArray for the same reason —
// the write side also buys quota recovery, which a raw setItem here would skip.
//
// Loaded after visit-shape.js — normalizeVisit gates every synced-down trip row.

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

    // Write-side counterpart to readSection: every section write goes through
    // storage.js's writeStoredArray, NOT a raw setItem. That matters most here —
    // a sync-down carries the full route geometry storage.js trims locally, so
    // these are the largest writes the app ever makes and the likeliest to hit a
    // full quota. writeStoredArray recovers by trimming old visit geometry and
    // toasts on hard failure; a raw setItem would instead throw mid-restore.
    // Returns false when the write could not be made durable.
    function writeSection(section, rows) {
        return globalThis.writeStoredArray(sectionKey(section), rows);
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
    // this a synced-down favorite stays {id, payload:{…}} and destLat is undefined
    // (#2065). The list renderer skips that row instead of throwing (#7307), but
    // the star button still needs the flat shape to match.
    // visits and history are the trip shape visit-shape.js owns, so a synced-down
    // row goes through the same gate an uploaded backup file does (importVisits).
    // Without it, rows written before server-side validation existed (see
    // server/src/lib/validate-rows.ts) land raw in localStorage, where
    // renderVisitedLayer skips them on every render while updateVisitedCounter
    // still counts them (#2735).
    //
    // A row normalizeVisit rejects is dropped rather than stored: it has no
    // usable start/dest/distance, so nothing can ever draw it, and the cloud copy
    // is untouched — mergeSection only writes localStorage, it never pushes
    // deletes. Local rows are NOT normalized here; they enter mergeSection from
    // readSection and stay as they are, so this can only ever discard a server
    // row the device already could not use.
    //
    // Two fields survive outside normalizeVisit's fixed key set: `id`, because
    // mergeSection keys on it (a row normalizeVisit cannot give a usable id is
    // dropped, matching mergeSection's own `if (!row.id) return`), and
    // `updatedAt`, because it drives last-write-wins — dropping it would make
    // every synced-down row look like epoch 0 on the next merge and let a stale
    // local row win forever.
    function normalizeTripRows(section, serverRows) {
        var normalizeVisit = globalThis.normalizeVisit;
        if (typeof normalizeVisit !== 'function') { return serverRows; }
        var nowIso = new Date().toISOString();
        var out = [];
        serverRows.forEach(function (row) {
            var norm = normalizeVisit(row, nowIso);
            if (!norm || !norm.id) { return; }
            // history is snapshotSession's shape with no poiCategory; that key is
            // the visits-only graft and has no column on the history table.
            if (section === 'history') { delete norm.poiCategory; }
            if (row && row.updatedAt !== undefined) { norm.updatedAt = row.updatedAt; }
            out.push(norm);
        });
        return out;
    }

    function normalizeServerRows(section, serverRows) {
        if (section === 'visits' || section === 'history') {
            return normalizeTripRows(section, serverRows);
        }
        // savedLocations is {label, value} and a favorite is a bookmark (dest
        // only, no start, no distance) — neither is a trip row, and running
        // either through the trip gate would delete the whole section.
        if (section !== 'favorites') { return serverRows; }
        return serverRows.map(function (row) {
            if (!row || typeof row.payload !== 'object' || row.payload === null) { return row; }
            var flat = Object.assign({}, row.payload, { id: row.id });
            if (row.updatedAt !== undefined) { flat.updatedAt = row.updatedAt; }
            return flat;
        });
    }

    // GET /:username omits polylines on old visit/history rows. Last-write-wins
    // on the whole row would replace local coords with null on every page load
    // of a bound account. Geometry is keep-if-present: a stripped snapshot must
    // not wipe coords this device still has; server coords still restore a
    // locally-trimmed row (the cloud archive).
    function keepLocalGeometry(server, local) {
        if (!local) return server;
        var out = server;
        if (local.routeCoords && !server.routeCoords) {
            if (out === server) out = Object.assign({}, server);
            out.routeCoords = local.routeCoords;
            if (local.routeDuration != null && (out.routeDuration == null)) {
                out.routeDuration = local.routeDuration;
            }
        }
        if (local.returnRouteCoords && !server.returnRouteCoords) {
            if (out === server) out = Object.assign({}, server);
            out.returnRouteCoords = local.returnRouteCoords;
            if (local.returnRouteDuration != null && (out.returnRouteDuration == null)) {
                out.returnRouteDuration = local.returnRouteDuration;
            }
        }
        return out;
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
                if (rowTs >= existingTs) { byId[row.id] = keepLocalGeometry(row, existing); }
            }
        });
        var merged = Object.keys(byId).map(function (id) { return byId[id]; });
        return writeSection(section, merged);
    }

    function populateSection(section, serverRows) {
        return writeSection(section, normalizeServerRows(section, serverRows));
    }

    function wipeSections() {
        DATA_SECTIONS.forEach(function (s) {
            localStorage.removeItem(sectionKey(s));
        });
    }

    // Capture the four sections' raw stored values so a destructive apply can be
    // rolled back. Raw strings rather than parsed arrays so the restore is
    // byte-for-byte — an absent key stays absent, and a section this module never
    // successfully rewrites isn't quietly normalized on the way back.
    function snapshotSections() {
        var snap = {};
        DATA_SECTIONS.forEach(function (s) {
            snap[s] = localStorage.getItem(sectionKey(s));
        });
        return snap;
    }

    // Put a snapshotSections() capture back, undoing a wipe plus whatever a failed
    // apply managed to write. Wipes first so the restore writes into the space the
    // snapshot came from: a partial apply may have left a much larger payload in one
    // key, and without the clear the rollback could hit quota re-writing data that
    // demonstrably fit moments earlier. Returns false if any section could not be
    // put back — that is data loss the caller must surface, not swallow.
    function restoreSections(snap) {
        wipeSections();
        var ok = true;
        DATA_SECTIONS.forEach(function (s) {
            var raw = snap ? snap[s] : null;
            if (raw === null || raw === undefined) { return; }
            try {
                localStorage.setItem(sectionKey(s), raw);
            } catch (e) {
                ok = false;
            }
        });
        return ok;
    }

    globalThis.SyncSections = {
        DATA_SECTIONS: DATA_SECTIONS,
        sectionKey: sectionKey,
        readSection: readSection,
        writeSection: writeSection,
        isLocalStorageEmpty: isLocalStorageEmpty,
        normalizeServerRows: normalizeServerRows,
        mergeSection: mergeSection,
        populateSection: populateSection,
        wipeSections: wipeSections,
        snapshotSections: snapshotSections,
        restoreSections: restoreSections
    };

}());
