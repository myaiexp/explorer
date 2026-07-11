// Favorites CRUD — the star button plus the bookmarked-destinations list.

// FAVORITES_KEY + getFavorites live in storage.js; syncedPut/syncedDelete/
// maybeRequestConsent in sync-helpers.js; snapshotSession in session.js;
// buildListItem in list-item.js; restoreResult in history.js; currentSession in
// app.js — all resolved as globals at call time.

// Favorite-identity predicate: does this favorite point at the same destination
// as `dest` (a session or another favorite)? Matched by dest coords at 6-decimal
// precision. Sole owner of the match rule so the star button and the favorites
// list can never disagree — change the precision (or match by id) here once.
function sameFavoriteDest(fav, dest) {
    return fav.destLat.toFixed(6) === dest.destLat.toFixed(6) &&
           fav.destLng.toFixed(6) === dest.destLng.toFixed(6);
}

function toggleFavorite() {
    if (!currentSession) return;
    const btn = document.getElementById('favoriteBtn');
    const favs = getFavorites();

    const idx = favs.findIndex(f => sameFavoriteDest(f, currentSession));

    if (idx >= 0) {
        const removed = favs[idx];
        favs.splice(idx, 1);
        btn.classList.remove('active');
        syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id));
    } else {
        const newFav = snapshotSession(currentSession);
        favs.unshift(newFav);
        btn.classList.add('active');
        syncedPut(FAVORITES_KEY, favs, 'favorites', newFav.id, newFav);
        maybeRequestConsent();
    }
    renderFavoritesSection();
}

function updateFavoriteBtn() {
    const btn = document.getElementById('favoriteBtn');
    if (!currentSession) { btn.classList.remove('active'); return; }
    const isFav = getFavorites().some(f => sameFavoriteDest(f, currentSession));
    btn.classList.toggle('active', isFav);
}

function deleteFavorite(index, event) {
    event.stopPropagation();
    const favs = getFavorites();
    const removed = favs[index];
    favs.splice(index, 1);
    syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id));
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
