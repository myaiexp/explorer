// Visits JSON backup — export the visits collection to a file and import it back.

// getVisits/VISITS_KEY/writeStoredArray live in storage.js; ExplorerSync in
// sync.js; maybeRequestConsent in sync-helpers.js; showError/showSuccess in
// toast.js; triggerDownload in export.js; updateVisitedCounter/renderVisitedLayer
// in app.js — all resolved as globals at call time.

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
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('Invalid format');
            const existing = getVisits();
            const existingIds = new Set(existing.map(v => v.id));
            const newEntries = imported.filter(v => !existingIds.has(v.id));
            // Give every imported entry a stable id, then mirror each to the
            // cloud outbox exactly as markAsVisited does. Without this, imported
            // visits live only in localStorage and silently never replicate to
            // the cloud backup when sync is active.
            for (const v of newEntries) {
                if (!v.id) v.id = crypto.randomUUID();
            }
            writeStoredArray(VISITS_KEY, [...existing, ...newEntries]);
            for (const v of newEntries) {
                ExplorerSync.mutate('visits', 'put', v.id, v);
            }
            maybeRequestConsent();
            showSuccess(`Added ${newEntries.length} new ${newEntries.length === 1 ? 'visit' : 'visits'}.`);
            updateVisitedCounter();
            renderVisitedLayer();
        } catch {
            showError('Failed to import: invalid JSON file.');
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

globalThis.exportVisits = exportVisits;
globalThis.importVisits = importVisits;
