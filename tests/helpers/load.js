/**
 * Shared bootstrap for the repo-root browser scripts under test — one idiom for
 * evaluating them, and the one place that mirrors index.html's load order.
 *
 * The scripts under test are classic (non-module) <script> files: each assigns
 * its public names onto globalThis and reads its collaborators back off
 * globalThis at load or call time. A test therefore only needs them evaluated,
 * in dependency order, in the current realm.
 *
 * `vm.compileFunction(src).call(globalThis)` is that evaluation, and it is the
 * ONLY idiom here on purpose. This suite used to carry two — readFileSync +
 * vm.Script in the node-environment files, ?raw + new Function in the jsdom ones
 * — so a load-order fix applied to one style silently missed the other (audit
 * #5443). compileFunction has new Function's semantics — a function scope, so
 * re-evaluating a script with a top-level `const` does not throw; sloppy mode
 * unless the script opts in; `this` is globalThis — and works under both vitest
 * environments, since jsdom tests run in Node's own realm with the window
 * copied onto globalThis. What it adds over new Function is a filename with no
 * textual wrapper: V8 names the script after the real file and its offsets match
 * the file exactly, so v8 coverage and stack traces land on geometry.js:22
 * instead of an anonymous function (finding #10112). Don't go back to new
 * Function — its `(function anonymous(` prefix shifts every coverage offset.
 *
 * Sources arrive through the virtual module from ./root-scripts-plugin.js, not
 * Vite's ?raw glob: v8 coverage keys a module by its path with the query
 * stripped, so each `?raw` string module was reported as the script's own
 * coverage (100% for every root script, run or not). The plugin adds each script
 * as a watch file, so watch mode still re-runs a test when a script it loads is
 * edited — as with the old eager glob, every root edit re-runs every test that
 * imports this helper. The import is static, which keeps the API synchronous.
 *
 * Note: security-hook warning acknowledged — evaluating source is intentional.
 * The sources are static local repo files, not user input.
 */

import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
// 'screening' → { path: '/abs/…/screening.js', src: '…' }
import ROOT_SCRIPTS from 'virtual:wander-root-scripts';

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
    'osrm':         ['net', 'geometry', 'loop-quality'],
    // fetchWithTimeout only: the bbox/distance math moved server-side with the
    // Overpass queries, so overpass.js no longer touches geo-utils.
    'overpass':     ['net'],
    'result-panel': ['session-state'],
    // geometry + result-panel are pure/real collaborators named in the header;
    // map-view / session / elevation / favorites are faked by route-view tests.
    // map-view.test.js loads map-view.js for real against a Leaflet stub, but
    // map-view is not a SCRIPT_DEPS key: adding it would force route-view to
    // list it via the reverse-completeness check and clobber those stubs.
    'route-view':   ['session-state', 'geometry', 'result-panel'],
    'visits-io':    ['visit-shape'],
    // The synced-down trip rows go through the same normalizeVisit gate an
    // uploaded backup file does (#2735), so visit-shape must load first.
    'sync-sections': ['visit-shape'],
    'sync':         ['sync-flush', 'sync-sections', 'sync-init'],
    // The state machine reads the section helpers directly (mergeSection /
    // populateSection / wipeSections), so it needs them loaded too.
    'sync-init':    ['sync-sections'],
    // restoreFromHash gates on inFinland so a shared Stockholm link never
    // hits OSRM-foot. Tests load share-link for real; bbox is the one
    // collaborator that is not faked.
    'share-link':   ['bbox'],
};

/** Raw source text of a repo-root script, by bare name ('osrm', not 'osrm.js'). */
export function readScript(name) {
    if (!Object.hasOwn(ROOT_SCRIPTS, name)) {
        throw new Error(`no repo-root script named '${name}.js' (bare name, no extension)`);
    }
    return ROOT_SCRIPTS[name].src;
}

/**
 * Evaluate one script's source in the current realm. `filename` names the V8
 * script, so pass it only when `src` is that file's exact text — anything else
 * maps coverage and stack traces onto the wrong lines. The escape hatch for the
 * one test that must transform the source first (fit-encoder injects an
 * internals export, then evalScript) passes none: the patched text is not the
 * file on disk. Every other test goes through loadScripts and reads what it
 * needs back off globalThis — never slice a single function out of a source,
 * since the slice cannot see a sibling helper it later calls.
 */
export function evalScript(src, filename) {
    vm.compileFunction(src, [], filename ? { filename } : {}).call(globalThis);
}

/**
 * Load the named repo-root scripts plus their SCRIPT_DEPS, in dependency order.
 * Deduped within the call, but NOT across calls — repeat calls re-evaluate, which
 * is what the tests that reload a module per-test rely on.
 */
export function loadScripts(...names) {
    const seen = new Set();
    const order = [];
    const visit = (name, chain) => {
        if (seen.has(name)) return;
        if (chain.includes(name)) {
            throw new Error(`circular SCRIPT_DEPS: ${[...chain, name].join(' → ')}`);
        }
        for (const dep of SCRIPT_DEPS[name] || []) visit(dep, [...chain, name]);
        seen.add(name);
        order.push(name);
    };
    for (const name of names) visit(name, []);
    for (const name of order) {
        evalScript(readScript(name), pathToFileURL(ROOT_SCRIPTS[name].path).href);
    }
    return order;
}
