// Shared setup for the loop-builder suites — load, latch reset, fixtures.
/**
 * loop-builders.test.js and junction-loop.test.js both drive the real builders
 * over the real OSRM transport with a fetch stub keyed on the endpoint kind.
 * SCRIPT_DEPS lists loop-builders' real edges (osrm, overpass, geometry,
 * loop-quality), so loadScripts('loop-builders') evaluates all of them, and
 * fetchWithTimeout calls the per-test `fetch` stub.
 */
import { beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './load.js';

/** Call once at a suite's top level. */
export function installLoopBuilderSuite() {
    beforeAll(() => {
        loadScripts('loop-builders');
    });
    // osrm.js's self-hosted-down latch is module state that survives every
    // test in the file; a test that trips it would send later tests straight
    // to the public fallback without this reset.
    beforeEach(() => {
        globalThis.resetOsrmFallbackState();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
}

export const START = { lat: 60, lng: 24 };
export const DEST = { lat: 60.1, lng: 24.1 };
export const SPREAD = () => globalThis.computeSpreadParams(50);

/** Every /route/ URL the stub saw, in call order. */
export function routeUrls(fetchMock) {
    return fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((u) => u.includes('/route/'));
}

/** buildJunctionLoop's options with a 7 km budget and a spy for onProgress. */
export const LOOP_OPTS = () => ({
    maxKm: 7,
    onProgress: vi.fn(),
    spread: SPREAD(),
});
