// Shared list-row DOM — the .history-item factory and the × delete button, plus
// the destination-row render loop behind the history and favorites lists. Loaded
// after visit-shape.js (for destCoordsOrNull).

// The × delete button every list row carries, saved-locations' rows included.
function buildDeleteButton(onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete';
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', onDelete);
    return del;
}

// Build the shared .history-item skeleton used by both the history and the
// favorites lists: a name line, a meta line, and a × delete button. Callers
// supply the label/meta text plus the select and delete click handlers.
function buildListItem(label, meta, onSelect, onDelete) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.addEventListener('click', onSelect);

    const nameEl = document.createElement('div');
    nameEl.className = 'history-item-name';
    nameEl.textContent = label;
    item.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'history-item-meta';
    metaEl.textContent = meta;
    item.appendChild(metaEl);

    item.appendChild(buildDeleteButton(onDelete));

    return item;
}

// A stored destination's row label: its name, or its coords when it has none.
// `dest` is the entry's destCoordsOrNull result.
function destListLabel(entry, dest) {
    return entry.destName ||
        `${dest.destLat.toFixed(4)}, ${dest.destLng.toFixed(4)}`;
}

// A stored destination's walk distance, or '' when the row carries none.
function destListDistance(entry) {
    return Number.isFinite(entry.distance) ? `${entry.distance.toFixed(1)} km` : '';
}

// Replace `list`'s rows with one per usable entry and return how many it drew.
// meta(entry) gives the meta line; onSelect(i) and onDelete(i, event) receive the
// entry's position in `entries`, which a skipped row does not shift, so a caller
// can index the same-ordered stored array with it. warnLabel names the caller in
// the skip warning.
function renderDestRows(entries, list, { meta, onSelect, onDelete, warnLabel }) {
    list.replaceChildren();
    let skipped = 0;
    let rendered = 0;
    entries.forEach((entry, i) => {
        // Skip rather than throw: both callers run from app.js's top level, so one
        // unusable stored row used to abort hash restore and the rest of init —
        // the same class visitRenderParts closed for visits.
        const dest = destCoordsOrNull(entry);
        if (!dest) { skipped++; return; }
        list.appendChild(buildListItem(destListLabel(entry, dest), meta(entry),
            () => onSelect(i),
            (e) => onDelete(i, e)));
        rendered++;
    });
    if (skipped > 0) {
        console.warn(`${warnLabel}: skipped ${skipped} unusable row(s)`);
    }
    return rendered;
}

globalThis.buildDeleteButton = buildDeleteButton;
globalThis.buildListItem = buildListItem;
globalThis.destListLabel = destListLabel;
globalThis.destListDistance = destListDistance;
globalThis.renderDestRows = renderDestRows;
