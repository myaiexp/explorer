// Global loading spinner + the one-build-at-a-time mutex every route build runs
// through. Loaded before the build modules; showWarning comes from toast.js.

// Why the mutex: a route build mutates state shared with every other build — the
// Leaflet layers (clearMap/drawRouteGlow), the current session, and the history
// store. Two overlapping builds interleave, so run B's clearMap() lands before
// run A draws (A's polylines are never removed and both routes stack on the map),
// whichever OSRM response returns last wins the display while the *other* run's
// session is what "Mark as visited" saves, both runs write a history row and a
// cloud mutation for one user action, and the first to finish re-enables the
// button and hides the spinner while the second is still fetching.
//
// Disabling #generateBtn — the only guard before — covered exactly one entry
// point. Enter on the three inputs, Ctrl+Enter, the surprise button, a map click
// in pick mode and the spread slider all reach a build without touching it, and
// an Overpass retry can keep a build alive for minutes.
let buildInFlight = false;

function isBuilding() {
    return buildInFlight;
}

// Guard for entry points: true means "a build owns the app right now, bail".
// Callers that mutate shared state (clearing the session, resetting the result
// panel, scrambling the form) must call this BEFORE that mutation, so a rejected
// request leaves the running build's state untouched. Single owner of the
// user-facing message so the rejection reads the same from every entry point.
function rejectIfBuilding() {
    if (!buildInFlight) return false;
    showWarning('Still building your route — hang tight.');
    return true;
}

// Run an async task with the global loading spinner active and the generate
// button disabled. Restores both and resets the loading caption in a finally,
// so every caller gets identical setup/teardown even when the task throws.
// Passes `fn` an onProgress(msg) callback that writes the loading caption.
// Callers keep their own error handling (showError).
//
// Returns true if `fn` ran, false if it was rejected by the mutex. The check
// here is the backstop — an entry point that forgets rejectIfBuilding() still
// can't start a concurrent build.
async function withLoading(fn) {
    if (rejectIfBuilding()) return false;
    buildInFlight = true;
    const loadingEl = document.getElementById('loading');
    const genBtn = document.getElementById('generateBtn');
    const onProgress = msg => { loadingEl.querySelector('p').textContent = msg; };
    loadingEl.classList.add('active');
    genBtn.disabled = true;
    try {
        await fn(onProgress);
        return true;
    } finally {
        buildInFlight = false;
        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        genBtn.disabled = false;
    }
}

globalThis.isBuilding = isBuilding;
globalThis.rejectIfBuilding = rejectIfBuilding;
globalThis.withLoading = withLoading;
