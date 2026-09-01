// Entry point — wires the modules together and paints the first frame.
//
// app.js owns no feature: it is the last script in index.html and does nothing
// but composition. Every concern it used to carry lives in a sibling now —
// session-state.js (the current route), loading.js (the spinner + the one-build
// mutex), route-view.js (render a route), route-restore.js (route to a known
// destination), result-panel.js (the panel's derived button state), generate.js
// (the pick-a-new-destination pipeline), pick-mode.js, share-link.js,
// spread-control.js, visited.js, location-input.js, poi-types.js, prefs-modal.js,
// overflow-menu.js and form-controls.js. Each states what it is loaded after in
// its own header.

// Re-render every localStorage-backed view. Fired on wander-sync-state-change
// so a cloud sync that lands AFTER the initial paint — the own-device merge or
// adopting a backup link, both of which rewrite localStorage once init's GET
// resolves — becomes visible immediately instead of waiting for a manual reload.
// (The synchronous render calls below still paint pre-sync local data first.)
function refreshDataViews() {
    renderVisitedLayer();
    updateVisitedCounter();
    renderFavoritesSection();
    renderHistorySection();
    renderSavedLocations();
}
window.addEventListener('wander-sync-state-change', refreshDataViews);

// Settings restore runs after poi-types.js has populated the destination select,
// otherwise the saved destination type has no option to select.
restoreSettings();
initSettingsListeners();
renderSavedLocations();
updateSaveLocationBtn();
WanderSync.init().finally(updateSyncMenu);
updateSyncMenu();
renderVisitedLayer();
updateVisitedCounter();
renderFavoritesSection();
renderHistorySection();
restoreFromHash();

// Update star button when location input changes
document.getElementById('location').addEventListener('input', updateSaveLocationBtn);
