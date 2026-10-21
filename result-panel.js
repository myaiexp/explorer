// Result-panel button state, derived from the session on screen. Loaded after
// session-state.js and favorites.js (updateFavoriteBtn); resolved as globals at
// call time.

// The mark-visited button is DERIVED state, never independent DOM state: it
// always reflects whether the session currently displayed has a recorded visit.
// Called from every path that swaps the session (displayRoute) or the visit
// (markAsVisited).
//
// It used to be set imperatively at each site, which desynced two ways: opening
// a history entry after marking a route visited kept the 'Visited! (undo)' label
// over a session with no visitId, so the undo click fell through to the create
// branch and silently recorded the restored route as an extra walk; and a spread
// reroute cleared the label while keeping visitId, so the next click deleted a
// visit the button said had never been made.
// Same end-to-end rule as isMeasuredWalk (session.js), inlined. result-panel is
// not a session.js dependency: route-view tests stub those helpers, and a
// SCRIPT_DEP would overwrite the stubs when the script loads.
function sessionRoutedEndToEnd(session) {
    if (!session?.routeCoords?.length) return false;
    if (session.tripMode !== 'one-way' && !session.returnRouteCoords?.length) return false;
    return true;
}

function syncMarkVisitedBtn() {
    const session = getCurrentSession();
    const visited = Boolean(session && session.visitId);
    const btn = document.getElementById('markVisitedBtn');
    // Undo stays available even when the stored walk has no geometry. A new
    // mark does not: the distance would be the crow-flies stand-in.
    const canMark = visited || sessionRoutedEndToEnd(session);
    btn.classList.toggle('marked', visited);
    btn.disabled = !canMark;
    btn.title = canMark
        ? ''
        : 'This route was not fully routed, so its distance is an estimate and is not saved as a walk.';
    btn.textContent = visited ? 'Visited! (undo)' : 'Mark as visited';
}

// Clear the panel ahead of a build that hasn't produced a route yet (the session
// is null by then, so the two syncs below reset the label and drop the star).
// Also hides any stale elevation chart — renderRouteTail re-hides it per render,
// but only once the new route has coords.
function resetResultPanel() {
    syncMarkVisitedBtn();
    updateFavoriteBtn();
    document.getElementById('elevationContainer').classList.remove('active');
}

globalThis.syncMarkVisitedBtn = syncMarkVisitedBtn;
globalThis.resetResultPanel = resetResultPanel;
