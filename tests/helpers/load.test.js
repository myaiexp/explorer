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

    // Forward completeness: each listed edge must be named in the dependent
    // module's source (usually its "Loaded after …" header). Catches fictional
    // edges — a dep that SCRIPT_DEPS claims but the source never mentions.
    test.each(EDGES)('%s is named in %s source', (dep, mod) => {
        expect(readScript(mod)).toMatch(new RegExp(`${dep}(\\.js)?`));
    });

    // Reverse completeness (audit #6234 / #5733 class): dropping a real
    // collaborator from SCRIPT_DEPS left the forward check green. For every
    // SCRIPT_DEPS key, every other SCRIPT_DEPS-keyed module named in its
    // leading "Loaded after …" header must be listed as a direct dep. Keys are
    // modules the suite loads for real with real collaborators — naming one
    // in the header without listing it is the omission the #5733 osrm →
    // loop-quality gap was. (Modules that only resolve collaborators as
    // faked globals use freeform "lives in X.js" comments without "Loaded
    // after", so they stay out of this check by design.)
    const SCRIPT_DEPS_KEYS = Object.keys(SCRIPT_DEPS);

    function loadedAfterKeyDeps(mod) {
        // Only the "Loaded after …" sentence(s), not later header notes that
        // casually name other modules (geometry's "shared with novelty.js").
        // Slice from "Loaded after" to the next blank comment line.
        const lines = readScript(mod).split('\n');
        let i = 0;
        while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) {
            if (/Loaded after/i.test(lines[i])) break;
            i++;
        }
        if (i >= lines.length || !/Loaded after/i.test(lines[i])) return [];
        const sentence = [];
        for (; i < lines.length; i++) {
            if (!lines[i].startsWith('//') || lines[i].trim() === '//' || lines[i].trim() === '') break;
            sentence.push(lines[i]);
        }
        const mentioned = [...sentence.join('\n').matchAll(/([a-z0-9-]+)\.js/g)]
            .map((m) => m[1]);
        return [...new Set(mentioned)].filter(
            (name) => name !== mod && SCRIPT_DEPS_KEYS.includes(name),
        );
    }

    test.each(SCRIPT_DEPS_KEYS)(
        '%s lists every SCRIPT_DEPS-keyed module from its Loaded-after header',
        (mod) => {
            const required = loadedAfterKeyDeps(mod);
            for (const dep of required) {
                expect(SCRIPT_DEPS[mod]).toContain(dep);
            }
        },
    );

    // Pin the pure-helper edges that the header phrasing does not cover
    // (screening says "Dependencies" not "Loaded after") or that are the
    // historical gap sites — so a silent drop fails even if wording drifts.
    test('critical real-load edges cannot be silently dropped', () => {
        expect(SCRIPT_DEPS.osrm).toEqual(
            expect.arrayContaining(['net', 'geometry', 'loop-quality']),
        );
        expect(SCRIPT_DEPS.screening).toEqual(
            expect.arrayContaining(['geo-utils', 'novelty']),
        );
        expect(SCRIPT_DEPS.sync).toEqual(
            expect.arrayContaining(['sync-flush', 'sync-sections']),
        );
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
