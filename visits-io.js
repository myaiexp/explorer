// Visits JSON backup — export the visits collection to a file and import it back.

// getVisits/VISITS_KEY/writeStoredArray live in storage.js; ExplorerSync in
// sync.js; maybeRequestConsent in sync-helpers.js; showError/showSuccess/
// showWarning in toast.js; triggerDownload in export.js; normalizeVisit in
// visit-shape.js; updateVisitedCounter in visited.js; renderVisitedLayer in
// map-view.js — all resolved as globals at call time.

function exportVisits() {
    const visits = getVisits();
    if (visits.length === 0) { showError('No visits to export yet.'); return; }
    const date = new Date().toISOString().split('T')[0];
    // Explicit filename — a date-stamped name the download sanitizer would mangle.
    triggerDownload(JSON.stringify(visits, null, 2), '', '', 'application/json', `walks-${date}.json`);
}

function importVisits(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        // Only the untrusted-parse and shape check are caught here. Everything
        // after them is our own code, and a throw there is a bug that must
        // surface with its stack — it used to be relabeled 'invalid JSON file',
        // which both misnamed the failure and hid that the rows had ALREADY been
        // written to localStorage.
        let parsed;
        try {
            parsed = JSON.parse(e.target.result);
        } catch {
            showError('Failed to import: invalid JSON file.');
            event.target.value = '';
            return;
        }
        if (!Array.isArray(parsed)) {
            showError('Failed to import: expected a JSON array of walks.');
            event.target.value = '';
            return;
        }
        try {
            applyImportedVisits(parsed);
        } finally {
            // Reset the picker either way, so re-selecting the same file still
            // fires a change event even if the merge threw.
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}

// Merge already-parsed rows into the visits collection. Every row is normalized
// BEFORE anything is persisted (visit-shape.js) — an unvalidated row used to be
// written and queued for upload first, and only then handed to the renderer,
// where a missing coord or distance threw. Since renderVisitedLayer also runs at
// app.js's top level, that left the app throwing part-way through init on every
// subsequent page load with no in-app way out.
//
// Split out from the FileReader plumbing so the merge contract is testable
// without a File. Returns { added, skipped }.
function applyImportedVisits(parsed) {
    const normalized = [];
    let skipped = 0;
    for (const row of parsed) {
        const visit = normalizeVisit(row);
        if (visit) normalized.push(visit);
        else skipped++;
    }

    const existing = getVisits();
    const existingIds = new Set(existing.map(v => v.id));
    // Dedupe on the file's own ids, before back-filling: an id minted first would
    // never match anything, so re-importing a file whose rows carry no ids would
    // duplicate every walk on every import.
    const newEntries = normalized.filter(v => v.id === null || !existingIds.has(v.id));
    for (const v of newEntries) {
        if (!v.id) v.id = crypto.randomUUID();
    }

    // Gate mirror + success toast on a durable local write. writeStoredArray
    // already toasts QUOTA_FULL on hard failure; mutating the outbox or claiming
    // "Added N visits" when nothing landed would desync cloud from local.
    if (!writeStoredArray(VISITS_KEY, [...existing, ...newEntries])) {
        return { added: 0, skipped };
    }
    // Mirror each row to the cloud outbox exactly as markAsVisited does. Without
    // this, imported visits live only in localStorage and silently never
    // replicate to the cloud backup when sync is active.
    for (const v of newEntries) {
        ExplorerSync.mutate('visits', 'put', v.id, v);
    }
    maybeRequestConsent();

    // One toast, not two: #notification holds a single message (toast.js), so a
    // follow-up warning would overwrite the count the user actually wanted.
    const added = `Added ${newEntries.length} new ${newEntries.length === 1 ? 'visit' : 'visits'}.`;
    if (skipped === 0) {
        showSuccess(added);
    } else {
        showWarning(`${added} Skipped ${skipped} malformed ${skipped === 1 ? 'entry' : 'entries'}.`);
    }

    updateVisitedCounter();
    renderVisitedLayer();
    return { added: newEntries.length, skipped };
}

globalThis.exportVisits = exportVisits;
globalThis.importVisits = importVisits;
globalThis.applyImportedVisits = applyImportedVisits;
