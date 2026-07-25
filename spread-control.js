// Spread slider control — the loop-width slider and its debounced auto-reroute.
// Loaded after route-view.js (renderRouteTail/getSpreadParams), loading.js and
// session-state.js; resolved as globals at call time.

const SPREAD_DEBOUNCE_MS = 400;   // slider drag
const SPREAD_STEP_DEBOUNCE_MS = 200; // +/- stepper click
const SPREAD_RETRY_MS = 400;      // re-arm delay while a build owns the app

let spreadDebounce = null;

function scheduleReroute(delay) {
    clearTimeout(spreadDebounce);
    spreadDebounce = setTimeout(runSpreadReroute, delay);
}

// A build in flight owns the map, the session and the spinner, so the reroute
// cannot just run. Re-arm rather than drop it: the slider is persistent UI state,
// and dropping the adjustment would leave the drawn route silently disagreeing
// with the slider. The retry converges as soon as the build's finally clears the
// flag (a build always ends, success or throw).
async function runSpreadReroute() {
    if (isBuilding()) { scheduleReroute(SPREAD_RETRY_MS); return; }
    await rerouteWithCurrentSpread();
}

// Re-route the current session's start/dest with the new spread value.
// Only re-fetches routes, does NOT pick a new destination.
async function rerouteWithCurrentSpread() {
    const session = getCurrentSession();
    if (!session) return;
    const { startLat, startLng, destLat, destLng } = session;

    try {
        await withLoading(async (onProgress) => {
            onProgress('Adjusting route…');
            // Keep markers and circles, only clear route lines
            clearRouteLines();

            const { tripMode } = session;
            let junctions = session.junctions || null;
            const smartRouting = tripMode !== 'one-way' && document.getElementById('smartRouting').checked;
            const r = await buildRouteForMode(startLat, startLng, destLat, destLng, {
                tripMode,
                smartRouting,
                winterMode: smartRouting && document.getElementById('winterMode').checked,
                maxKm: parseFloat(document.getElementById('maxDistance').value),
                onProgress,
                cachedJunctions: junctions,
                buildingMessage: null,
                spread: getSpreadParams(),
            });
            const outbound = r.outbound;
            const ret = r.return;
            if (tripMode !== 'one-way') junctions = r.junctions;

            // Redraw routes, refit, badges, directions link, elevation — the same
            // render tail displayRoute uses. No straight-line fallback: keep the
            // previous view in place if a spread change yields no route.
            const { totalWalkKm } = renderRouteTail(
                startLat, startLng, destLat, destLng, outbound, ret, tripMode, getRouteColor(),
                { fallbackStraight: false });

            // Same destination, same visit: spread only changes the path, so
            // visitId (and the mark-visited button derived from it) carries over.
            setCurrentSession({
                ...session,
                distance: totalWalkKm,
                ...routeSessionFields(outbound, ret),
                junctions,
            });
        });
    } catch (error) {
        showError(error.message || 'Failed to adjust route.');
    }
}

document.getElementById('spreadSlider').addEventListener('input', () => {
    // Only auto-reroute if there's an active route to adjust
    if (!getCurrentSession()) return;
    scheduleReroute(SPREAD_DEBOUNCE_MS);
});

function adjustSpread(delta) {
    const slider = document.getElementById('spreadSlider');
    const newVal = Math.max(0, Math.min(100, parseInt(slider.value, 10) + delta));
    slider.value = newVal;
    if (!getCurrentSession()) return;
    scheduleReroute(SPREAD_STEP_DEBOUNCE_MS);
}

globalThis.rerouteWithCurrentSpread = rerouteWithCurrentSpread;
globalThis.adjustSpread = adjustSpread;
