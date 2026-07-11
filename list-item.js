// Shared .history-item DOM factory used by the history and favorites lists.

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

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete';
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', onDelete);
    item.appendChild(del);

    return item;
}

globalThis.buildListItem = buildListItem;
