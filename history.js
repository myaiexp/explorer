// Visit-history CRUD — the recent-routes list and its restore/expand controls.

// HISTORY_KEY + getHistory live in storage.js; syncedPut/syncedDelete/
// maybeRequestConsent in sync-helpers.js; snapshotSession in session.js;
// buildListItem in list-item.js; clearMap/displayRoute in app.js — all resolved
// as globals at call time.

const HISTORY_MAX = 20;
const HISTORY_VISIBLE = 3;
let historyExpanded = false;

function saveToHistory(session) {
    const entry = snapshotSession(session);
    const history = getHistory();
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    syncedPut(HISTORY_KEY, history, 'history', entry.id, entry);
    maybeRequestConsent();
    renderHistorySection();
}

function deleteHistoryEntry(index) {
    const history = getHistory();
    const removed = history[index];
    history.splice(index, 1);
    syncedDelete(HISTORY_KEY, history, 'history', String(removed.id));
    renderHistorySection();
}

function restoreResult(entry) {
    clearMap();
    // Prefer the real per-leg distances when the entry has them. Legacy entries
    // (saved before per-leg distances existed, or pulled from the cloud where
    // only the total is stored) fall back to assigning the whole total to the
    // outbound leg — numerically correct for the displayed total, which is all
    // displayRoute renders.
    const hasLegDist = typeof entry.routeDistance === 'number';
    const outbound = entry.routeCoords
        ? { coords: entry.routeCoords,
            distance: (hasLegDist ? entry.routeDistance : entry.distance) * 1000,
            duration: entry.routeDuration || 0 }
        : null;
    const ret = entry.returnRouteCoords
        ? { coords: entry.returnRouteCoords,
            distance: (hasLegDist ? (entry.returnRouteDistance || 0) : 0) * 1000,
            duration: entry.returnRouteDuration || 0 }
        : null;
    // No saveToHistory here: re-displaying an existing history/favorite entry
    // must not create a new one (the old side effect in displayRoute did).
    displayRoute({
        startLat: entry.startLat, startLng: entry.startLng,
        destLat: entry.destLat, destLng: entry.destLng,
        outbound, ret,
        locationInput: entry.startLabel, destName: entry.destName, tripMode: entry.tripMode,
    });
}

function renderHistorySection() {
    const history = getHistory();
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const moreBtn = document.getElementById('historyMoreBtn');

    if (history.length === 0) {
        section.classList.remove('visible');
        return;
    }

    section.classList.add('visible');
    const shown = historyExpanded ? history : history.slice(0, HISTORY_VISIBLE);
    list.replaceChildren();
    shown.forEach((entry, i) => {
        const label = entry.destName ||
            `${entry.destLat.toFixed(4)}, ${entry.destLng.toFixed(4)}`;
        const date = new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const dist = entry.distance ? `${entry.distance.toFixed(1)} km` : '';
        const meta = [dist, date].filter(Boolean).join(' · ');

        const item = buildListItem(label, meta,
            () => restoreResult(getHistory()[i]),
            (e) => { e.stopPropagation(); deleteHistoryEntry(i); });
        list.appendChild(item);
    });

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
globalThis.restoreResult = restoreResult;
globalThis.renderHistorySection = renderHistorySection;
globalThis.toggleHistoryExpanded = toggleHistoryExpanded;
