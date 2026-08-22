// @vitest-environment node
/**
 * Drift guard for the HIGHWAY_EXCLUDE road-filter presets that exist in two
 * independent deployables:
 *   - explorer/overpass.js          (frontend, direct Overpass calls)
 *   - junctions-cache/src/overpass.ts (shelly microservice, server-cached)
 *
 * The strings MUST stay byte-identical: the server caches junctions computed
 * from its copy, and the frontend expects those to match what its own copy
 * would have selected. There is no shared build to enforce this (the two ship
 * separately), so this test is the enforcement — it fails RED the moment either
 * copy changes without the other. Both files carry a reciprocal TWIN comment
 * pointing here.
 *
 * The frontend copy is read as its real runtime value (overpass.js only declares
 * functions + these consts at load — no DOM/network/haversineKm until a
 * fetcher is called), so we load it via helpers/load.js's loadScripts('overpass')
 * and read the globals. The .ts copy can't be evaluated as-is (it's outside the
 * loader's repo-root *.js glob anyway), so its two literals are extracted from
 * source text with readFileSync; a missing literal throws loudly, signalling
 * the format changed.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadScripts } from './helpers/load.js';

const TS_PATH = resolve(__dirname, '../junctions-cache/src/overpass.ts');

let frontend;

beforeAll(() => {
    loadScripts('overpass');
    frontend = {
        default: globalThis.HIGHWAY_EXCLUDE_DEFAULT,
        winter: globalThis.HIGHWAY_EXCLUDE_WINTER,
    };
});

// Pull `<preset>: '<value>'` out of the HIGHWAY_EXCLUDE record in overpass.ts.
function tsPreset(preset) {
    const ts = readFileSync(TS_PATH, 'utf8');
    const m = ts.match(new RegExp(`${preset}:\\s*'([^']+)'`));
    if (!m) throw new Error(`HIGHWAY_EXCLUDE.${preset} literal not found in overpass.ts — did the format change?`);
    return m[1];
}

describe('HIGHWAY_EXCLUDE parity: overpass.js ↔ junctions-cache/overpass.ts', () => {
    test('the frontend copy actually holds both presets', () => {
        expect(typeof frontend.default).toBe('string');
        expect(typeof frontend.winter).toBe('string');
        expect(frontend.default.length).toBeGreaterThan(0);
        expect(frontend.winter.length).toBeGreaterThan(0);
    });

    test('default preset is byte-identical across both deployables', () => {
        expect(frontend.default).toBe(tsPreset('default'));
    });

    test('winter preset is byte-identical across both deployables', () => {
        expect(frontend.winter).toBe(tsPreset('winter'));
    });
});
