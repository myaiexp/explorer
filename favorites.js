// Favorites CRUD — the star button plus the bookmarked-destinations list.
// Loaded after visit-shape.js (for destCoordsOrNull).

// FAVORITES_KEY + getFavorites live in storage.js; syncedPut/syncedDelete/
// maybeRequestConsent in sync-helpers.js; snapshotSession in session.js;
// buildListItem in list-item.js; restoreResult in route-view.js;
// getCurrentSession in session-state.js — all resolved as globals at call time.

// Favorite-identity predicate: does this favorite point at the same destination
// as `dest` (a session or another favorite)? Matched by dest coords at 6-decimal
// precision. Sole owner of the match rule so the star button and the favorites
// list can never disagree — change the precision (or match by id) here once.
// A stored row (or a session) without finite dest coords is not a match — never
// throw, so a corrupt favorite cannot abort first paint via the star button.
function sameFavoriteDest(fav, dest) {
    const a = destCoordsOrNull(fav);
    const b = destCoordsOrNull(dest);
    if (!a || !b) return false;
    return a.destLat.toFixed(6) === b.destLat.toFixed(6) &&
           a.destLng.toFixed(6) === b.destLng.toFixed(6);
}

function toggleFavorite() {
    const session = getCurrentSession();
    if (!session) return;
    const btn = document.getElementById('favoriteBtn');
    const favs = getFavorites();

    const idx = favs.findIndex(f => sameFavoriteDest(f, session));

    if (idx >= 0) {
        const removed = favs[idx];
        favs.splice(idx, 1);
        // Gate the optimistic button flip on a durable write — otherwise the
        // star shows inactive while localStorage still holds the row.
        if (!syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id))) return;
        btn.classList.remove('active');
    } else {
        const newFav = snapshotSession(session);
        favs.unshift(newFav);
        if (!syncedPut(FAVORITES_KEY, favs, 'favorites', newFav.id, newFav)) return;
        btn.classList.add('active');
        maybeRequestConsent();
    }
    renderFavoritesSection();
}

function updateFavoriteBtn() {
    const btn = document.getElementById('favoriteBtn');
    const session = getCurrentSession();
    if (!session) { btn.classList.remove('active'); return; }
    const isFav = getFavorites().some(f => sameFavoriteDest(f, session));
    btn.classList.toggle('active', isFav);
}

function deleteFavorite(index, event) {
    event.stopPropagation();
    const favs = getFavorites();
    const removed = favs[index];
    favs.splice(index, 1);
    if (!syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id))) return;
    renderFavoritesSection();
    updateFavoriteBtn();
}

function renderFavoritesSection() {
    const favs = getFavorites();
    const section = document.getElementById('favoritesSection');
    const list = document.getElementById('favoritesList');

    if (favs.length === 0) {
        section.classList.remove('visible');
        return;
    }

    list.replaceChildren();
    let skipped = 0;
    let rendered = 0;
    favs.forEach((entry, i) => {
        // Skip rather than throw: this runs from app.js's top level, so one
        // unusable stored row used to abort history, hash restore, and the rest
        // of init — the same class visitRenderParts closed for visits.
        const dest = destCoordsOrNull(entry);
        if (!dest) { skipped++; return; }
        const label = entry.destName ||
            `${dest.destLat.toFixed(4)}, ${dest.destLng.toFixed(4)}`;
        const dist = Number.isFinite(entry.distance) ? `${entry.distance.toFixed(1)} km` : '';
        const item = buildListItem(label, dist,
            () => { restoreResult(getFavorites()[i]); updateFavoriteBtn(); },
            (e) => deleteFavorite(i, e));
        list.appendChild(item);
        rendered++;
    });
    if (skipped > 0) {
        console.warn(`renderFavoritesSection: skipped ${skipped} unusable favorite row(s)`);
    }
    section.classList.toggle('visible', rendered > 0);
}

globalThis.sameFavoriteDest = sameFavoriteDest;
globalThis.toggleFavorite = toggleFavorite;
globalThis.updateFavoriteBtn = updateFavoriteBtn;
globalThis.deleteFavorite = deleteFavorite;
globalThis.renderFavoritesSection = renderFavoritesSection;
