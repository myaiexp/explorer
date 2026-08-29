// @vitest-environment node
/**
 * Repo-root scripts are classic <script> tags, not modules — every top-level
 * `function foo` becomes a property of the one shared global object, and the
 * last file to load wins. So two files declaring the same name is not a
 * namespacing nit: the loser's callers silently start executing the winner's
 * function.
 *
 * Caught for real while adding the public-OSRM throttle: osrm.js grew a
 * top-level `function sleep`, and because index.html loads osrm.js after
 * overpass.js, overpass.js's retry backoff would have started calling it.
 * The two implementations were identical, so nothing failed — which is
 * precisely why this needs a test rather than a code review.
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['vitest.config.js']);

function rootScripts() {
    return readdirSync(ROOT)
        .filter((f) => f.endsWith('.js') && !SKIP.has(f));
}

/** Top-level `function name(` declarations — column 0 only, so nested ones don't count. */
function topLevelFunctions(source) {
    return [...source.matchAll(/^function ([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
}

describe('classic-script global scope', () => {
    test('no two repo-root scripts declare the same top-level function', () => {
        const owners = new Map();
        for (const file of rootScripts()) {
            for (const name of topLevelFunctions(readFileSync(join(ROOT, file), 'utf8'))) {
                if (!owners.has(name)) owners.set(name, []);
                owners.get(name).push(file);
            }
        }

        const collisions = [...owners.entries()]
            .filter(([, files]) => files.length > 1)
            .map(([name, files]) => `${name}: ${files.join(', ')}`);

        expect(collisions).toEqual([]);
    });

    test('the scan actually sees the scripts it is guarding', () => {
        // A broken glob would make the test above pass vacuously.
        const files = rootScripts();
        expect(files).toContain('osrm.js');
        expect(files).toContain('overpass.js');
        expect(files.length).toBeGreaterThan(20);
        expect(topLevelFunctions(readFileSync(join(ROOT, 'overpass.js'), 'utf8')))
            .toContain('sleep');
    });
});
