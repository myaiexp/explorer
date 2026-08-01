// @vitest-environment node
/**
 * Tests for tests/helpers/load.js — the shared classic-script loader.
 *
 * load.js is now the single place that encodes index.html's load order for the
 * test suite (audit #5443, which replaced ~20 hand-rolled beforeAll bootstraps).
 * A single source of truth is only worth having if it stays true, so these are
 * the tripwires: every name in SCRIPT_DEPS must resolve to a real repo-root
 * script, and no edge may contradict the order of the <script> tags in
 * index.html. Reorder index.html without updating SCRIPT_DEPS and this goes RED
 * instead of the map quietly becoming fiction.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SCRIPT_DEPS, readScript, loadScripts } from './load.js';

// index.html isn't a repo-root *.js file, so it's outside the loader's glob.
const INDEX_HTML = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

// Bare script names in <script src="..."> order, local files only (Leaflet's CDN
// tag has no bare name to match). 'net.js?v=__COMMIT__' → 'net'.
const INDEX_ORDER = [...INDEX_HTML.matchAll(/<script src="([a-z0-9-]+)\.js\?/g)]
    .map((m) => m[1]);

const EDGES = Object.entries(SCRIPT_DEPS).flatMap(([mod, deps]) =>
    deps.map((dep) => [dep, mod]),
);

test('index.html parsed a plausible script list (guards the regex itself)', () => {
    expect(INDEX_ORDER.length).toBeGreaterThan(30);
    expect(INDEX_ORDER[0]).toBe('net');
    expect(INDEX_ORDER.at(-1)).toBe('app');
});

describe('SCRIPT_DEPS', () => {
    const NAMES = [...new Set(Object.keys(SCRIPT_DEPS).concat(EDGES.flat()))];

    test.each(NAMES)('%s resolves to a real repo-root script', (name) => {
        expect(() => readScript(name)).not.toThrow();
    });

    test.each(NAMES)('%s is loaded by index.html', (name) => {
        expect(INDEX_ORDER).toContain(name);
    });

    // The actual drift guard: a dep must be a script index.html loads EARLIER.
    test.each(EDGES)('%s loads before %s in index.html', (dep, mod) => {
        expect(INDEX_ORDER.indexOf(dep)).toBeLessThan(INDEX_ORDER.indexOf(mod));
    });

    // Completeness (not just order): each listed edge must be named in the
    // dependent module's source — usually its "Loaded after …" header. Without
    // this, SCRIPT_DEPS can omit a real free-identifier collaborator (the
    // osrm → loop-quality gap, audit #5733) and the order tripwire stays green.
    test.each(EDGES)('%s is named in %s source', (dep, mod) => {
        expect(readScript(mod)).toMatch(new RegExp(`${dep}(\\.js)?`));
    });
});

describe('loadScripts', () => {
    test('returns dependencies before their dependents, transitively', () => {
        // screening → [geo-utils, novelty], and novelty → [geo-utils].
        expect(loadScripts('screening')).toEqual(['geo-utils', 'novelty', 'screening']);
    });

    test('dedupes within a call but keeps first-wins order', () => {
        expect(loadScripts('geo-utils', 'novelty')).toEqual(['geo-utils', 'novelty']);
    });

    test('a module with no SCRIPT_DEPS entry loads alone', () => {
        expect(loadScripts('bbox')).toEqual(['bbox']);
    });

    test('unknown name throws a name-shaped error, not a silent no-op', () => {
        expect(() => loadScripts('geo-utils.js')).toThrow(/bare name, no extension/);
        expect(() => loadScripts('nope')).toThrow(/no repo-root script/);
    });
});
