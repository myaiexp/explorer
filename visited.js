// Visited walks — mark/undo the displayed route as visited, the visited counter,
// and the map overlay's visibility toggle. Loaded after storage.js (getVisits/
// VISITS_KEY), sync-helpers.js, session.js (snapshotSession), map-view.js
// (renderVisitedLayer/visitedLayerGroup), session-state.js and result-panel.js
// (syncMarkVisitedBtn); resolved as globals at call time.

// Overlay visibility is UI state owned here; the overlay itself (renderVisitedLayer,
// visitedLayerGroup) lives in map-view.js.
let visitedLayerVisible = true;

function markAsVisited() {
    const session = getCurrentSession();
    if (!session) return;

    // Undo: remove visit if already marked
    if (session.visitId) {
        const undoneId = session.visitId;
        const visits = getVisits().filter(v => v.id !== undoneId);
        // Gate session/UI updates on a durable local write. syncedDelete already
        // toasts on hard quota failure; stamping visitId=null while the row is
        // still in localStorage makes the button lie and the counter/layer disagree.
        if (!syncedDelete(VISITS_KEY, visits, 'visits', String(undoneId))) return;
        session.visitId = null;
        syncMarkVisitedBtn();
        updateVisitedCounter();
        renderVisitedLayer();
        return;
    }

    const visit = snapshotSession(session, {
        poiCategory: session.poiCategory || null,
    });

    const visits = getVisits();
    visits.push(visit);
    // Same gate on create: never stamp session.visitId or re-render as visited
    // when the local write (and therefore the cloud mirror) did not land.
    if (!syncedPut(VISITS_KEY, visits, 'visits', visit.id, visit)) return;
    maybeRequestConsent();
    session.visitId = visit.id;

    // Button label is derived from the session's visitId, never set here — see
    // syncMarkVisitedBtn in result-panel.js.
    syncMarkVisitedBtn();
    updateVisitedCounter();
    renderVisitedLayer();
}

function toggleVisitedLayer() {
    const btn = document.getElementById('toggleVisitedBtn');
    if (visitedLayerVisible) {
        map.removeLayer(visitedLayerGroup);
        visitedLayerVisible = false;
        btn.textContent = 'Show visited routes';
    } else {
        visitedLayerGroup.addTo(map);
        visitedLayerVisible = true;
        btn.textContent = 'Hide visited routes';
    }
}

function updateVisitedCounter() {
    const count = getVisits().length;
    document.getElementById('visitedCount').textContent = `${count} visited`;

    const exploredEl = document.getElementById('exploredCount');
    if (count > 0) {
        const places = count === 1 ? 'place' : 'places';
        exploredEl.textContent = `${count} ${places} explored`;
        exploredEl.style.display = 'block';
    } else {
        exploredEl.style.display = 'none';
    }
}

globalThis.markAsVisited = markAsVisited;
globalThis.toggleVisitedLayer = toggleVisitedLayer;
globalThis.updateVisitedCounter = updateVisitedCounter;
