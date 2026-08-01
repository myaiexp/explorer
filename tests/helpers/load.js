/**
 * Shared bootstrap for the repo-root browser scripts under test — one idiom for
 * evaluating them, and the one place that mirrors index.html's load order.
 *
 * The scripts under test are classic (non-module) <script> files: each assigns
 * its public names onto globalThis and reads its collaborators back off
 * globalThis at load or call time. A test therefore only needs them evaluated,
 * in dependency order, in the current realm.
 *
 * `new Function(src).call(globalThis)` is that evaluation, and it is the ONLY
 * idiom here on purpose. This suite used to carry two — readFileSync + vm.Script
 * in the node-environment files, ?raw + new Function in the jsdom ones — so a
 * load-order fix applied to one style silently missed the other (audit #5443).
 * new Function needs no Node built-ins, so it works under both vitest
 * environments; the `@vitest-environment node` pragmas that remain are about
 * skipping jsdom setup, not about reaching `vm`.
 *
 * Sources arrive through Vite's ?raw glob rather than fs.readFileSync so watch
 * mode knows a test depends on the scripts it loads — with readFileSync, editing
 * screening.js would not re-run screening.test.js. The glob is eager, which
 * keeps the API synchronous at the cost of pulling every root script into each
 * test's module graph (so any root edit re-runs the suite in watch mode). Don't
 * trade that for a lazy glob without also making loadScripts async and awaiting
 * it at every call site.
 *
 * Note: security-hook warning acknowledged — new Function() is intentional. The
 * sources are static local repo files, not user input.
 */

const RAW = import.meta.glob('../../*.js', {
    query: '?raw',
    import: 'default',
    eager: true,
});

// '../../screening.js' → 'screening'
const SOURCES = Object.fromEntries(
    Object.entries(RAW).map(([path, src]) => [path.replace(/^.*\/|\.js$/g, ''), src]),
);

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
    'fit-encoder':  ['geo-utils'],             // aliases haversineM
    // geometry → geo-utils and loop-quality → geo-utils transitively; net has no deps.
    'osrm':         ['net', 'geometry', 'loop-quality'],
    'result-panel': ['session-state'],
    'route-view':   ['session-state'],
    'visits-io':    ['visit-shape'],
    'sync':         ['sync-flush', 'sync-sections'],
};

/** Raw source text of a repo-root script, by bare name ('osrm', not 'osrm.js'). */
export function readScript(name) {
    const src = SOURCES[name];
    if (src === undefined) {
        throw new Error(`no repo-root script named '${name}.js' (bare name, no extension)`);
    }
    return src;
}

/**
 * Evaluate one script's source in the current realm. The escape hatch for tests
 * that must transform the source first (fit-encoder injects an internals export)
 * or extract a single declaration from it (corridor-junctions).
 */
export function evalScript(src) {
    new Function(src).call(globalThis); // eslint-disable-line no-new-func
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
    for (const name of order) evalScript(readScript(name));
    return order;
}
