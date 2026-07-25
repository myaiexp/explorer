// Pick-on-map mode — click the map to route to a destination of your choosing.
// Loaded after map-view.js (map), loading.js, location-input.js (resolveStart),
// route-restore.js (buildAndDisplay) and result-panel.js (resetResultPanel);
// resolved as globals at call time.

let pickMode = false;

// Map-click handler installed while pick mode is active: resolve the start,
// build a route to the clicked point, and render it. Hoisted to module scope
// (was an inline closure in togglePickMode) so exitPickMode can detach it by
// reference with map.off('click', handlePickClick).
async function handlePickClick(e) {
    // Checked before exitPickMode so a click during a build leaves pick mode
    // armed — the user's next click after the build lands works as intended
    // instead of the click being swallowed along with the mode.
    if (rejectIfBuilding()) return;

    exitPickMode();
    const destLat = e.latlng.lat;
    const destLng = e.latlng.lng;
    setCurrentSession(null);
    resetResultPanel();

    await withLoading(async (onProgress) => {
        try {
            const { startLat, startLng, locationInput } = await resolveStart();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            await buildAndDisplay(startLat, startLng, destLat, destLng, {
                tripMode, locationInput, destName: null, onProgress,
                buildingMessage: 'Building route…',
            });
        } catch (error) {
            showError(error.message || 'An error occurred. Please try again.');
        }
    });
}

function togglePickMode() {
    const btn = document.getElementById('pickDestBtn');
    if (pickMode) {
        exitPickMode();
        return;
    }

    // Validate that we have a start location first
    const locationInput = document.getElementById('location').value.trim();
    if (!locationInput) {
        showError('Please enter a starting location first.');
        return;
    }

    pickMode = true;
    btn.classList.add('active');
    btn.textContent = 'Cancel';
    map.getContainer().style.cursor = 'crosshair';
    showSuccess('Click anywhere on the map to set your destination');

    map.on('click', handlePickClick);
}

function exitPickMode() {
    pickMode = false;
    const btn = document.getElementById('pickDestBtn');
    btn.classList.remove('active');
    btn.textContent = 'Pick on map';
    map.getContainer().style.cursor = '';
    map.off('click', handlePickClick);
}

globalThis.handlePickClick = handlePickClick;
globalThis.togglePickMode = togglePickMode;
globalThis.exitPickMode = exitPickMode;
