// index.html's script load order as a dependency graph — the one copy tests load by.
// Pure data with no imports, so plain Node (scripts/test-related.mjs) can read it
// as well as tests/helpers/load.js.

/**
 * index.html's load order, as "load these before that". Entries list DIRECT
 * dependencies only — loadScripts walks the graph transitively.
 *
 * What belongs here: the real-source dependencies a module needs when a test
 * loads it for real. A module whose collaborators the test fakes on globalThis
 * instead (destination-resolve, visited, favorites, history, …) needs no entry —
 * the stubs are its dependencies, and pulling real sources in would clobber
 * them. When a module gains a real dependency — as screening.js did when it
 * moved to geo-utils' haversineM — adding the edge here is the single edit, and
 * every test that loads the module picks it up.
 */
export const SCRIPT_DEPS = {
    'geometry':     ['geo-utils'],
    'loop-quality': ['geo-utils'],
    'novelty':      ['geo-utils'],
    'screening':    ['geo-utils', 'novelty'],  // novelty supplies partialShuffle (capPool dep)
    'fit-encoder':  ['geo-utils'],             // haversineM
    // Sampling interpolates with haversineM; fetch goes through fetchWithTimeout.
    'elevation':    ['net', 'geo-utils'],
    // geometry → geo-utils and loop-quality → geo-utils transitively; net has no deps.
    // fetchWithTimeout, plus haversineKm for snapToRoad's distance check.
    'osrm':         ['net', 'geo-utils'],
    // osrm owns fetchRouteThrough + snapToRoad; overpass owns
    // fetchCorridorJunctions, which buildJunctionLoop calls; geometry owns
    // loopVias, which both loop builders call.
    'loop-builders': ['osrm', 'overpass', 'geometry', 'loop-quality'],
    // fetchWithTimeout, plus kmToDegLat/Lng for the corridor bbox padding. The
    // pool bbox/distance math moved server-side with the Overpass queries.
    'overpass':     ['net', 'geo-utils'],
    'result-panel': ['session-state'],
    // The visited counter counts rows visitRenderParts accepts. Other visited.js
    // collaborators are faked by its tests; this one is the real predicate.
    'visited':      ['visit-shape'],
    // geometry (loopVias, computeSpreadParams) + result-panel are pure/real
    // collaborators named in the header — a suite that fakes loopVias installs the
    // stub AFTER loading route-view, or geometry's real one overwrites it;
    // map-view / session / elevation / favorites are faked by route-view tests.
    // map-view.test.js loads map-view.js for real against a Leaflet stub, but
    // map-view is not a SCRIPT_DEPS key: adding it would force route-view to
    // list it via the reverse-completeness check and clobber those stubs.
    'route-view':   ['session-state', 'geometry', 'result-panel'],
    'visits-io':    ['visit-shape'],
    // renderDestRows gates each stored row on the real destCoordsOrNull.
    'list-item':    ['visit-shape'],
    // The row's × button comes from list-item's buildDeleteButton.
    'saved-locations': ['list-item'],
    // The synced-down trip rows go through the same normalizeVisit gate an
    // uploaded backup file does (#2735), so visit-shape must load first.
    'sync-sections': ['visit-shape'],
    'sync':         ['sync-flush', 'sync-sections', 'sync-init', 'sync-accept'],
    // The state machine reads the section helpers directly (mergeSection /
    // populateSection / wipeSections), so it needs them loaded too.
    'sync-init':    ['sync-sections'],
    // accept() reads and rewrites the local sections it uploads.
    'sync-accept':  ['sync-sections'],
    // restoreFromHash gates on inFinland so a shared Stockholm link never
    // hits OSRM-foot. Tests load share-link for real; bbox is the one
    // collaborator that is not faked.
    'share-link':   ['bbox'],
};
