// Saved-locations CRUD — the named start-location shortcuts under the input.

// SAVED_LOCATIONS_KEY + getSavedLocations live in storage.js; syncedPut/
// syncedDelete/maybeRequestConsent in sync-helpers.js; showError/showSuccess in
// toast.js; saveSettings in settings.js — all loaded before this and used as
// globals.

function toggleSaveLocation() {
    const input = document.getElementById('location').value.trim();
    if (!input) { showError('Enter a location first.'); return; }
    const saved = getSavedLocations();
    const existing = saved.findIndex(s => s.value === input);
    if (existing >= 0) {
        const removed = saved[existing];
        saved.splice(existing, 1);
        // Gate success toast + re-render on a durable write. writeStoredArray
        // already toasts the quota error; claiming "removed" over it would lie.
        if (!syncedDelete(SAVED_LOCATIONS_KEY, saved, 'savedLocations', removed.id || String(removed.value))) return;
        showSuccess('Location removed from saved.');
    } else {
        const label = prompt('Name for this location:', input);
        if (label === null) return;
        const newLoc = { id: crypto.randomUUID(), label: label || input, value: input };
        saved.push(newLoc);
        if (!syncedPut(SAVED_LOCATIONS_KEY, saved, 'savedLocations', newLoc.id, newLoc)) return;
        maybeRequestConsent();
        showSuccess('Location saved.');
    }
    renderSavedLocations();
    updateSaveLocationBtn();
}

function selectSavedLocation(value) {
    document.getElementById('location').value = value;
    updateSaveLocationBtn();
    saveSettings();
}

function deleteSavedLocation(index, event) {
    event.stopPropagation();
    const saved = getSavedLocations();
    const removed = saved[index];
    saved.splice(index, 1);
    if (!syncedDelete(SAVED_LOCATIONS_KEY, saved, 'savedLocations', removed.id || String(removed.value))) return;
    renderSavedLocations();
    updateSaveLocationBtn();
}

function renderSavedLocations() {
    const container = document.getElementById('savedLocations');
    const saved = getSavedLocations();
    container.replaceChildren();
    for (let i = 0; i < saved.length; i++) {
        const item = document.createElement('div');
        item.className = 'saved-location-item';
        item.addEventListener('click', () => selectSavedLocation(saved[i].value));

        const label = document.createElement('span');
        label.className = 'saved-location-label';
        label.textContent = saved[i].label;
        item.appendChild(label);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'history-delete';
        del.title = 'Remove';
        del.textContent = '×';
        del.addEventListener('click', (e) => deleteSavedLocation(i, e));
        item.appendChild(del);

        container.appendChild(item);
    }
}

function updateSaveLocationBtn() {
    const btn = document.getElementById('saveLocationBtn');
    const input = document.getElementById('location').value.trim();
    const saved = getSavedLocations();
    const isSaved = saved.some(s => s.value === input);
    btn.style.color = isSaved ? '#fbbf24' : '';
    btn.querySelector('svg').setAttribute('fill', isSaved ? '#fbbf24' : 'none');
}

globalThis.toggleSaveLocation = toggleSaveLocation;
globalThis.selectSavedLocation = selectSavedLocation;
globalThis.deleteSavedLocation = deleteSavedLocation;
globalThis.renderSavedLocations = renderSavedLocations;
globalThis.updateSaveLocationBtn = updateSaveLocationBtn;
