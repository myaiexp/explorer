// The current route session — the single owner of "what route is on screen".

// A plain module-level `let` in app.js used to hold this, which made app.js both
// the top of the load order and a library its own dependents (export.js,
// favorites.js) reached back into. It lives here instead: every reader goes
// through getCurrentSession(), so the ownership is one-directional.
//
// The session object itself stays mutable by design — markAsVisited stamps
// visitId onto the live object, generateDestination stamps junctions — so
// getCurrentSession() hands out the real reference, not a copy.

let currentSession = null;

function getCurrentSession() {
    return currentSession;
}

// Returns the session it stored so callers can keep stamping fields on it.
function setCurrentSession(session) {
    currentSession = session;
    return currentSession;
}

globalThis.getCurrentSession = getCurrentSession;
globalThis.setCurrentSession = setCurrentSession;
