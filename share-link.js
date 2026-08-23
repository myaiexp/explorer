// Route sharing via the URL hash — encode the current route into a link, copy it,
// and restore one on load. Loaded after route-restore.js (buildAndDisplay),
// loading.js, session-state.js, toast.js and bbox.js (inFinland); resolved as
// globals at call time.

function encodeRouteHash() {
    const session = getCurrentSession();
    if (!session) return;
    const { startLat, startLng, destLat, destLng, tripMode, destName } = session;
    const params = new URLSearchParams({
        s: `${startLat.toFixed(6)},${startLng.toFixed(6)}`,
        d: `${destLat.toFixed(6)},${destLng.toFixed(6)}`,
        m: tripMode
    });
    if (destName) params.set('n', destName);
    return '#' + params.toString();
}

function copyRouteLink() {
    const hash = encodeRouteHash();
    if (!hash) return;
    const url = location.origin + location.pathname + hash;
    navigator.clipboard.writeText(url).then(
        () => showSuccess('Link copied to clipboard.'),
        () => showError('Failed to copy link.')
    );
}

// "lat,lng" → [lat, lng], or null when the pair is malformed. Number('') is 0,
// so a half-empty pair ("62.1,") would otherwise pass an isNaN check and route
// to a point on the null meridian instead of being rejected as a broken link.
function parseCoordPair(value) {
    const parts = value.split(',');
    if (parts.length !== 2) return null;
    const [lat, lng] = parts.map(p => p.trim() === '' ? NaN : Number(p));
    return (isNaN(lat) || isNaN(lng)) ? null : [lat, lng];
}

async function restoreFromHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;

    // A malformed shared link silently no-ops: the early returns below are the
    // whole handling. Nothing in the parse throws — URLSearchParams, split and
    // Number all coerce rather than fail — so a link with missing or garbage
    // coordinates falls out at one of the two guards. Out-of-Finland coords are
    // well-formed but rejected with the same user-facing error as resolveStart
    // (OSRM-foot only covers FI). Routing/display failures further down are NOT
    // swallowed: they surface via showError so a shared link that resolves but
    // can't be routed is visible to the user.
    const params = new URLSearchParams(hash);
    const s = params.get('s');
    const d = params.get('d');
    const m = params.get('m') || 'round';
    const n = params.get('n') || null;
    if (!s || !d) return;

    const start = parseCoordPair(s);
    const dest = parseCoordPair(d);
    if (!start || !dest) return;
    const [startLat, startLng] = start;
    const [destLat, destLng] = dest;

    // Same Finland gate as resolveStart: OSRM-foot only covers FI, so a
    // Stockholm (or otherwise out-of-bbox) shared link must not reach it.
    if (!inFinland(startLat, startLng) || !inFinland(destLat, destLng)) {
        showError('Wander only routes within Finland — pick a starting location inside the country.');
        return;
    }

    // Set UI state
    document.getElementById('location').value = s;
    if (m === 'one-way') document.getElementById('oneWay').checked = true;
    else document.getElementById('roundTrip').checked = true;

    try {
        await withLoading(async (onProgress) => {
            await buildAndDisplay(startLat, startLng, destLat, destLng, {
                tripMode: m, locationInput: s, destName: n, onProgress,
                loadingMessage: 'Loading shared route…',
            });
        });
        // Clear hash after a successful restore so it doesn't re-trigger.
        history.replaceState(null, '', location.pathname);
    } catch (error) {
        showError(error.message || 'Could not load the shared route.');
    }
}

globalThis.parseCoordPair = parseCoordPair;
globalThis.encodeRouteHash = encodeRouteHash;
globalThis.copyRouteLink = copyRouteLink;
globalThis.restoreFromHash = restoreFromHash;
