// @vitest-environment jsdom
/**
 * Drift guard for the POI catalog, which exists in two independent deployables:
 *   - wander/poi-types.js              (frontend, the dropdown the user picks from)
 *   - junctions-cache/src/poi-catalog.ts (shelly microservice, the query it runs)
 *
 * The frontend sends catalog KEYS; the server maps them to Overpass filters.
 * The filter strings must stay byte-identical in both directions:
 *   - a key the server does not know is a 400 on a type the dropdown offers;
 *   - a filter that has drifted returns a different set than the label promises,
 *     silently — Overpass answers a wrong-but-valid filter with an empty result,
 *     and the walk falls back to a random point with nothing to say why.
 *
 * There is no shared build to enforce this (the two ship separately), so this
 * test is the enforcement. Both files carry a reciprocal TWIN comment pointing
 * here. It must fail RED on a one-character change to either copy.
 *
 * jsdom, not node: poi-types.js runs populateLocationTypeSelect at load, which
 * touches `document`. It exits early when #locationTypeSelect is absent, so no
 * fixture is needed — only a realm where `document` exists.
 *
 * The frontend copy is read as its real runtime value via loadScripts. The .ts
 * copy cannot be evaluated here, so POI_FILTERS is extracted from source text;
 * a missing or unparseable block throws loudly rather than comparing nothing.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadScripts } from './helpers/load.js';

const TS_PATH = resolve(__dirname, '../junctions-cache/src/poi-catalog.ts');

let frontend;   // key → filter, from poi-types.js
let server;     // key → filter, from poi-catalog.ts

// Pull the POI_FILTERS record body out of poi-catalog.ts and parse its
// `key: 'filter'` pairs. Filters contain double quotes but never single quotes,
// so a single-quoted literal is unambiguous.
function readServerCatalog() {
    const ts = readFileSync(TS_PATH, 'utf8');
    const block = ts.match(/POI_FILTERS[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (!block) {
        throw new Error('POI_FILTERS record not found in poi-catalog.ts — did the format change?');
    }
    const out = {};
    for (const m of block[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
        out[m[1]] = m[2];
    }
    if (Object.keys(out).length === 0) {
        throw new Error('POI_FILTERS parsed to zero entries — the literal format changed');
    }
    return out;
}

beforeAll(() => {
    loadScripts('poi-types');
    frontend = Object.fromEntries(globalThis.POI_TYPES.map(p => [p.key, p.filter]));
    server = readServerCatalog();
});

describe('POI catalog parity: poi-types.js ↔ junctions-cache/poi-catalog.ts', () => {
    // Anti-vacuity: a comparison of two empty objects passes trivially.
    test('both copies actually hold a non-trivial catalog', () => {
        expect(Object.keys(frontend).length).toBeGreaterThan(5);
        expect(Object.keys(server).length).toBeGreaterThan(5);
    });

    test('every frontend POI key exists in the server catalog with a byte-identical filter', () => {
        for (const [key, filter] of Object.entries(frontend)) {
            expect(server, `server catalog is missing frontend key '${key}'`).toHaveProperty(key);
            expect(server[key], `filter drift on '${key}'`).toBe(filter);
        }
    });

    test('the server catalog has no key the frontend does not offer', () => {
        for (const key of Object.keys(server)) {
            expect(frontend, `server catalog has orphan key '${key}'`).toHaveProperty(key);
        }
    });

    // The two regex-sensitive shapes: a `~` alternation and a bare-key filter.
    // If the source-text extraction ever breaks, it breaks on these first.
    test('the regex and bare-key filter forms survive extraction intact', () => {
        expect(server.pub).toBe('["amenity"~"pub|bar"]');
        expect(server.historic).toBe('["historic"]');
    });
});
