// Visit-history CRUD — the recent-routes list and its restore/expand controls.

// HISTORY_KEY + getHistory live in storage.js; syncedPut/syncedDelete/
// maybeRequestConsent in sync-helpers.js; snapshotSession in session.js;
// renderDestRows + destListDistance in list-item.js; restoreResult in
// route-restore.js — all resolved as globals at call time.

const HISTORY_MAX = 20;
const HISTORY_VISIBLE = 3;
let historyExpanded = false;

function saveToHistory(session) {
    const entry = snapshotSession(session);
    const history = getHistory();
    history.unshift(entry);
    // Keep the most-recent HISTORY_MAX by date, and MIRROR the cap to the cloud.
    // Sorting first makes the cap correct even after an init merge (mergeSection
    // appends server-only rows unsorted), so the rows that fall off the tail are
    // genuinely the oldest. Those dropped ids must also be DELETEd server-side:
    // truncating locally alone leaves them on the server forever (unbounded
    // per-account growth) and the next merge unions them back by id — resurrecting
    // capped entries and ballooning local history past HISTORY_MAX (the cap and the
    // sync engine otherwise implement contradictory invariants). splice() both
    // truncates `history` in place and returns the aged-off tail.
    history.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
    const dropped = history.splice(HISTORY_MAX);
    // Gate the cloud-cap deletes + consent prompt on a durable put. If the local
    // write failed, the aged-off rows are still in storage — deleting them from
    // the cloud (or claiming a save happened) would desync the two sides.
    if (!syncedPut(HISTORY_KEY, history, 'history', entry.id, entry)) return;
    // syncedDelete re-persists the already-capped array (idempotent) and enqueues
    // the cloud delete; WanderSync.mutate no-ops for anonymous users, so an
    // un-synced browser just gets the local cap, exactly as before.
    dropped.forEach(d => { if (d && d.id != null) syncedDelete(HISTORY_KEY, history, 'history', String(d.id)); });
    maybeRequestConsent();
    renderHistorySection();
}

function deleteHistoryEntry(index) {
    const history = getHistory();
    const removed = history[index];
    history.splice(index, 1);
    if (!syncedDelete(HISTORY_KEY, history, 'history', String(removed.id))) return;
    renderHistorySection();
}

// restoreResult — re-displaying a stored entry — lives in route-restore.js: it is a
// render, not history CRUD, and favorites.js used to depend on this module solely
// to reach it.

function renderHistorySection() {
    const history = getHistory();
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const moreBtn = document.getElementById('historyMoreBtn');

    if (history.length === 0) {
        section.classList.remove('visible');
        return;
    }

    const shown = historyExpanded ? history : history.slice(0, HISTORY_VISIBLE);
    const rendered = renderDestRows(shown, list, {
        meta: (entry) => {
            const date = new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            return [destListDistance(entry), date].filter(Boolean).join(' · ');
        },
        // `shown` is a prefix of the stored order, so its index is the stored index.
        onSelect: (i) => restoreResult(getHistory()[i]),
        onDelete: (i, e) => { e.stopPropagation(); deleteHistoryEntry(i); },
        warnLabel: 'renderHistorySection',
    });
    section.classList.toggle('visible', rendered > 0);

    const hidden = history.length - HISTORY_VISIBLE;
    if (history.length > HISTORY_VISIBLE) {
        moreBtn.style.display = 'block';
        moreBtn.textContent = historyExpanded ? 'Show less' : `Show ${hidden} more`;
    } else {
        moreBtn.style.display = 'none';
    }
}

function toggleHistoryExpanded() {
    historyExpanded = !historyExpanded;
    renderHistorySection();
}

globalThis.saveToHistory = saveToHistory;
globalThis.deleteHistoryEntry = deleteHistoryEntry;
globalThis.renderHistorySection = renderHistorySection;
globalThis.toggleHistoryExpanded = toggleHistoryExpanded;
