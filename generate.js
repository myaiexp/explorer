// The generate pipeline — read the form, resolve a destination, build a route,
// display and persist it. The one entry point that picks a *new* destination
// (pick-mode.js and share-link.js route to a destination the user already chose).
// Loaded after loading.js, location-input.js, destination-resolve.js,
// route-view.js (readRouteBuildOptions), result-panel.js, history.js and
// session-state.js; resolved as globals at call time.

// Every visited destination, as [lat, lng] pairs — passed down as `existingDests`
// so the novelty ranking can push new picks away from places already walked.
function getAllExistingDestinations() {
    return getVisits().map(v => [v.destLat, v.destLng]);
}

// One "we're on the public backup" notice per page load. The condition lasts as
// long as the self-hosted backend is down, so warning on every generate would be
// nagging about something the user already knows and cannot fix.
let degradedNoticeShown = false;

async function generateDestination() {
    // Before any state is touched: a build in flight owns the map, the session
    // and the history store (see loading.js).
    if (rejectIfBuilding()) return;

    // Empty / non-numeric min is "no floor" (HTML default is 0). parseFloat of
    // '' or 'abc' is NaN, and || 0 is the coerce — not a missing-budget error.
    // Invalid max still rejects below; a search cannot start without a ceiling.
    const minKm = parseFloat(document.getElementById('minDistance').value) || 0;
    const maxKm = parseFloat(document.getElementById('maxDistance').value);

    if (isNaN(maxKm) || maxKm <= 0) { showError('Please enter a valid maximum distance greater than 0.'); return; }
    if (minKm < 0) { showError('Minimum distance cannot be negative.'); return; }
    if (minKm >= maxKm) { showError('Minimum distance must be less than maximum distance.'); return; }

    document.getElementById('notification').classList.remove('active');
    setCurrentSession(null);
    resetResultPanel();

    await withLoading(async (onProgress) => {
        try {
            const { startLat, startLng, locationInput } = await resolveStart();
            clearMap();

            const existingDests = getAllExistingDestinations();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            const rawLocationType = document.getElementById('locationTypeSelect').value;
            // Map the dropdown value to a routing strategy. Known values pass
            // through; anything else is a specific POI key and routes as 'poi'.
            // 'any' is listed explicitly so it stays visible: it resolves to a
            // fully random point anywhere, not to roads or POIs.
            const routingStrategy = ['roads', 'any_poi', 'any'].includes(rawLocationType) ? rawLocationType : 'poi';

            // Straight-line scaling: round trip ≈ budget / 2.6, one-way ≈ budget / 1.3
            const scale = tripMode === 'one-way' ? 1.3 : 2.6;
            const straightMin = minKm / scale;
            const straightMax = maxKm / scale;

            // Mode toggles + spread read once here, at the UI layer, and passed
            // down so the destination-resolve pipeline stays DOM-free. maxKm
            // was already parsed (and validated) above; keep that snapshot so
            // a field change during geocode cannot sneak an unvalidated budget
            // into the build. smartRouting is not read here: it is no longer a
            // toggle a caller can opt out of — buildRouteForDestination runs
            // its junction-snap retry loop unconditionally for every
            // non-degraded round trip (see destination-resolve.js).
            const { winterMode, spread, degraded } = readRouteBuildOptions(tripMode);

            // Resolve a candidate pool, then screen it for water-reachability.
            const resolved = await resolveCandidatePool(startLat, startLng, {
                routingStrategy, rawLocationType, straightMin, straightMax, existingDests, onProgress, winterMode });
            const screened = await screenCandidatePool(startLat, startLng, {
                candidatePool: resolved.candidatePool, dest: resolved.dest, destName: resolved.destName,
                existingDests, onProgress });
            const { candidatePool, waterLocked } = screened;

            // Smart round-trips may substitute a lower-overlap destination, so
            // read dest/destName back from the build result.
            const built = await buildRouteForDestination(startLat, startLng, {
                candidatePool, dest: screened.dest, destName: screened.destName,
                existingDests, maxKm, tripMode, spread, winterMode, degraded, onProgress });
            const { dest, destName, outbound: outboundRoute, return: returnRoute, junctions, overlap } = built;

            const session = displayRoute({
                startLat, startLng, destLat: dest.lat, destLng: dest.lng,
                outbound: outboundRoute, ret: returnRoute,
                locationInput, destName, tripMode, straightMax, straightMin,
                poiCategory: rawLocationType,
            });
            session.junctions = junctions;
            // Missing outbound means routing built nothing. displayRoute still
            // draws the dest (dashed straight-line fallback), but persisting
            // would store a fake walk in history and the cloud backup. Empty
            // coords is the same failure (tryOsrm used to return a truthy
            // {coords:[]} for a malformed OSRM 200 — finding #7926).
            if (outboundRoute?.coords?.length) saveToHistory(session);

            // Re-read the latch AFTER the build, not just before. Two different
            // questions: `degraded` above decided how much work to attempt and
            // has to be answered up front, while this one asks what actually
            // happened. They differ on exactly one build — the first after a
            // page load, which starts with the latch clear, discovers the
            // outage mid-flight and gets silently rescued by the fallback. That
            // build also pays the self-hosted timeout before falling back, so
            // it is both the slowest and, without this, the only unexplained one.
            const degradedNow = degraded || readRouteBuildOptions(tripMode).degraded;
            if (degradedNow && !degradedNoticeShown) {
                degradedNoticeShown = true;
                showWarning('Routing backend is down — using the public server. Routes are rougher and slower than usual.');
            }

            // Water-locked first: it is a diagnosed cause, so its advice ("try a
            // different start") is worth more than describing what is on screen.
            // The no-route branch deliberately does NOT guess why — during a
            // backend outage, telling someone to try another destination would
            // send them retrying something that cannot work.
            if (waterLocked) {
                showWarning('This area is mostly water — try a different start or larger radius.');
            } else if (!outboundRoute?.coords?.length) {
                showWarning('No walking route could be built — the dashed line is straight-line distance, not a route.');
            } else if (overlap !== null && overlap >= OVERLAP_BAD_THRESHOLD) {
                showWarning('This area has limited routing options — the loop overlaps significantly.');
            }
        } catch (error) {
            showError(error.message || 'An error occurred. Please try again.');
        }
    });
}

// Randomize the form, then generate. Guarded first so a click during a build
// doesn't scramble the form (and the persisted settings) for a build that will
// be rejected anyway.
function surpriseMe() {
    if (rejectIfBuilding()) return;

    // Random POI type (skip 'any' and 'roads', pick from actual POIs + any_poi)
    const choices = ['any_poi', ...POI_TYPES.map(p => p.key)];
    const pick = choices[Math.floor(Math.random() * choices.length)];
    document.getElementById('locationTypeSelect').value = pick;

    // Random distance: 1-8km range with random min/max
    const min = +(Math.random() * 3).toFixed(1);          // 0–3 km
    const max = +(min + 1 + Math.random() * 5).toFixed(1); // min+1 to min+6 km
    document.getElementById('minDistance').value = min;
    document.getElementById('maxDistance').value = max;

    // Random spread
    document.getElementById('spreadSlider').value = Math.round(Math.random() * 100);

    saveSettings();
    generateDestination();
}

globalThis.getAllExistingDestinations = getAllExistingDestinations;
globalThis.generateDestination = generateDestination;
globalThis.surpriseMe = surpriseMe;
