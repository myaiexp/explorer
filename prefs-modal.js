// Preferences modal — the route-color swatch grid and the modal's open/close.
// Loaded after map-view.js (ROUTE_COLORS/getRouteColor/setRouteColor/
// applyRouteColor); resolved as globals at call time.

function openPreferencesModal() {
    renderRouteColorSwatches();
    document.getElementById('prefsModal')?.classList.add('active');
}

function closePreferencesModal() {
    document.getElementById('prefsModal')?.classList.remove('active');
}

function renderRouteColorSwatches() {
    const grid = document.getElementById('routeColorSwatches');
    if (!grid) return;
    const active = getRouteColor();
    grid.replaceChildren();
    for (const c of ROUTE_COLORS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch' + (c.hex === active ? ' active' : '');
        btn.style.background = c.hex;
        btn.title = c.name;
        btn.setAttribute('aria-label', `Route color: ${c.name}`);
        btn.onclick = () => {
            setRouteColor(c.hex);
            applyRouteColor();
            renderRouteColorSwatches();
        };
        grid.appendChild(btn);
    }
}

// Each modal owns its own Escape wiring (export.js does the same for the FIT
// modal) instead of one shared handler in the entry point. Looked up at
// keydown time, not load time — a test (or a partial DOM) can be missing the
// node. classList on null throws on every Escape and can abort other Escape
// handlers; export.js uses the same `?.` on #fitModal.
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('prefsModal')?.classList.contains('active')) {
        closePreferencesModal();
    }
});

globalThis.openPreferencesModal = openPreferencesModal;
globalThis.closePreferencesModal = closePreferencesModal;
globalThis.renderRouteColorSwatches = renderRouteColorSwatches;
