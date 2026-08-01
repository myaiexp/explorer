// Favorites CRUD — the star button plus the bookmarked-destinations list.

// FAVORITES_KEY + getFavorites live in storage.js; syncedPut/syncedDelete/
// maybeRequestConsent in sync-helpers.js; snapshotSession in session.js;
// buildListItem in list-item.js; restoreResult in route-view.js;
// getCurrentSession in session-state.js — all resolved as globals at call time.

// Favorite-identity predicate: does this favorite point at the same destination
// as `dest` (a session or another favorite)? Matched by dest coords at 6-decimal
// precision. Sole owner of the match rule so the star button and the favorites
// list can never disagree — change the precision (or match by id) here once.
function sameFavoriteDest(fav, dest) {
    return fav.destLat.toFixed(6) === dest.destLat.toFixed(6) &&
           fav.destLng.toFixed(6) === dest.destLng.toFixed(6);
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

    section.classList.add('visible');
    list.replaceChildren();
    favs.forEach((entry, i) => {
        const label = entry.destName ||
            `${entry.destLat.toFixed(4)}, ${entry.destLng.toFixed(4)}`;
        const dist = entry.distance ? `${entry.distance.toFixed(1)} km` : '';
        const item = buildListItem(label, dist,
            () => { restoreResult(getFavorites()[i]); updateFavoriteBtn(); },
            (e) => deleteFavorite(i, e));
        list.appendChild(item);
    });
}

globalThis.sameFavoriteDest = sameFavoriteDest;
globalThis.toggleFavorite = toggleFavorite;
globalThis.updateFavoriteBtn = updateFavoriteBtn;
globalThis.deleteFavorite = deleteFavorite;
globalThis.renderFavoritesSection = renderFavoritesSection;
