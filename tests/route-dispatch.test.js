/**
 * Tests for route-dispatch.js — buildRouteForMode.
 *
 * Loading: route-dispatch.js is a non-module browser script. We load its
 * source and run it in the current realm via Node's vm module; its explicit
 * globalThis assignment exposes buildRouteForMode. The three route builders
 * (buildOneWay / buildJunctionLoop / buildLoop) are resolved from globalThis
 * at call time — exactly as in the browser, where app.js declares them as
 * window globals — so each test installs fakes on globalThis.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const SRC = readFileSync(resolve(__dirname, '../route-dispatch.js'), 'utf8');

beforeAll(() => {
    new vm.Script(SRC).runInThisContext();
});

let buildOneWay, buildJunctionLoop, buildLoop;

beforeEach(() => {
    buildOneWay = vi.fn(async () => ({ coords: ['oneway'], duration: 1, distance: 10 }));
    buildJunctionLoop = vi.fn(async () => ({
        outbound: { coords: ['jl-out'] },
        return: { coords: ['jl-ret'] },
        overlap: 0.1,
        junctions: [{ lat: 60, lng: 24 }],
    }));
    buildLoop = vi.fn(async () => ({
        outbound: { coords: ['loop-out'] },
        return: { coords: ['loop-ret'] },
    }));
    globalThis.buildOneWay = buildOneWay;
    globalThis.buildJunctionLoop = buildJunctionLoop;
    globalThis.buildLoop = buildLoop;
});

describe('buildRouteForMode dispatch', () => {
    // ── Branch: one-way ──────────────────────────────────────────────────────
    test('one-way (smart off) → buildOneWay only, documented shape, message shown', async () => {
        const onProgress = vi.fn();
        const r = await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'one-way', smartRouting: false, winterMode: false, onProgress,
            cachedJunctions: null, buildingMessage: 'Building route…',
        });
        expect(buildOneWay).toHaveBeenCalledTimes(1);
        expect(buildOneWay).toHaveBeenCalledWith(60, 24, 61, 25);
        expect(buildJunctionLoop).not.toHaveBeenCalled();
        expect(buildLoop).not.toHaveBeenCalled();
        expect(r).toEqual({
            outbound: { coords: ['oneway'], duration: 1, distance: 10 },
            return: null,
            junctions: null,
        });
        expect(onProgress).toHaveBeenCalledWith('Building route…');
    });

    test('one-way takes priority over smartRouting → buildOneWay, not buildJunctionLoop', async () => {
        const r = await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'one-way', smartRouting: true, winterMode: true, onProgress: vi.fn(),
        });
        expect(buildOneWay).toHaveBeenCalledTimes(1);
        expect(buildJunctionLoop).not.toHaveBeenCalled();
        expect(buildLoop).not.toHaveBeenCalled();
        expect(r.return).toBeNull();
        expect(r.junctions).toBeNull();
    });

    // ── Branch: smart round-trip ─────────────────────────────────────────────
    test('round-trip + smartRouting → buildJunctionLoop with exact arg order', async () => {
        const onProgress = vi.fn();
        const cached = [{ lat: 60, lng: 24 }];
        const r = await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'round', smartRouting: true, winterMode: true, maxKm: 12, onProgress,
            cachedJunctions: cached, buildingMessage: 'Building route…',
        });
        expect(buildJunctionLoop).toHaveBeenCalledTimes(1);
        // signature: (startLat, startLng, destLat, destLng, maxKm, onProgress, cachedJunctions, winterMode)
        expect(buildJunctionLoop).toHaveBeenCalledWith(60, 24, 61, 25, 12, onProgress, cached, true);
        expect(buildOneWay).not.toHaveBeenCalled();
        expect(buildLoop).not.toHaveBeenCalled();
        expect(r).toEqual({
            outbound: { coords: ['jl-out'] },
            return: { coords: ['jl-ret'] },
            junctions: [{ lat: 60, lng: 24 }],
        });
        // smart branch reports its own progress — must NOT emit the building message
        expect(onProgress).not.toHaveBeenCalledWith('Building route…');
    });

    test('round-trip + smartRouting → cachedJunctions defaults to null when omitted', async () => {
        await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'round', smartRouting: true, winterMode: false, onProgress: vi.fn(),
        });
        // maxKm omitted from opts → forwarded as undefined
        expect(buildJunctionLoop).toHaveBeenCalledWith(60, 24, 61, 25, undefined, expect.any(Function), null, false);
    });

    // ── Branch: plain loop ───────────────────────────────────────────────────
    test('round-trip + smart off → buildLoop only, junctions null, message shown', async () => {
        const onProgress = vi.fn();
        const r = await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'round', smartRouting: false, winterMode: false, onProgress,
            buildingMessage: 'Building route…',
        });
        expect(buildLoop).toHaveBeenCalledTimes(1);
        expect(buildLoop).toHaveBeenCalledWith(60, 24, 61, 25);
        expect(buildOneWay).not.toHaveBeenCalled();
        expect(buildJunctionLoop).not.toHaveBeenCalled();
        expect(r).toEqual({
            outbound: { coords: ['loop-out'] },
            return: { coords: ['loop-ret'] },
            junctions: null,
        });
        expect(onProgress).toHaveBeenCalledWith('Building route…');
    });

    // ── buildingMessage gating (sites 3 & 4 pass null) ───────────────────────
    test('no buildingMessage → onProgress not called for one-way / plain loop', async () => {
        const onProgress = vi.fn();
        await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'one-way', smartRouting: false, onProgress,
        });
        expect(onProgress).not.toHaveBeenCalled();

        onProgress.mockClear();
        await globalThis.buildRouteForMode(60, 24, 61, 25, {
            tripMode: 'round', smartRouting: false, onProgress,
        });
        expect(onProgress).not.toHaveBeenCalled();
    });
});
