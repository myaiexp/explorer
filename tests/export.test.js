// @vitest-environment jsdom
/**
 * Tests for export.js — mergeRouteCoords, exportGPX, the FIT modal guards,
 * and confirmFITExport (finding #7068). Filename sanitization of triggerDownload
 * lives in export-download.test.js; this file drives the GPX/FIT bodies.
 *
 * export.js is a non-module browser script; helpers/load.js evaluates it so
 * free identifiers (getCurrentSession, fetchElevations, FitEncoder, showError)
 * resolve to the stubs installed on globalThis.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

loadScripts('export');

let lastDownload;
let lastBlob;
let errors;

beforeEach(() => {
    lastDownload = null;
    lastBlob = null;
    errors = [];
    document.body.innerHTML = '<div id="fitModal" class="modal-backdrop"></div>';

    vi.restoreAllMocks();
    globalThis.showError = (msg) => { errors.push(msg); };
    globalThis.getCurrentSession = () => null;
    globalThis.fetchElevations = vi.fn(() => Promise.resolve([10, 20, 30]));
    globalThis.FitEncoder = {
        osrmStepsToCoursePoints: vi.fn(() => [{ type: 'generic' }]),
        encodeCourse: vi.fn(() => new Uint8Array([1, 2, 3])),
    };

    URL.createObjectURL = vi.fn((blob) => {
        lastBlob = blob;
        return 'blob:stub';
    });
    URL.revokeObjectURL = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        const el = realCreate(tag);
        if (tag === 'a') el.click = () => { lastDownload = el.download; };
        return el;
    });
});

describe('mergeRouteCoords', () => {
    const out = [[62.1, 25.7], [62.2, 25.8]];
    const ret = [[62.2, 25.8], [62.1, 25.7]];

    test('drops the duplicate destination when the join is within 1e-5', () => {
        const merged = mergeRouteCoords(out, ret);
        expect(merged).toEqual([[62.1, 25.7], [62.2, 25.8], [62.1, 25.7]]);
    });

    test('a near-dup under 1e-5 still drops the return start', () => {
        const near = [[62.2 + 9e-6, 25.8], [62.1, 25.7]];
        expect(mergeRouteCoords(out, near)).toHaveLength(3);
    });

    test('exactly 1e-5 is not a dup — concatenates every point', () => {
        const edge = [[62.2 + 1e-5, 25.8], [62.1, 25.7]];
        const merged = mergeRouteCoords(out, edge);
        expect(merged).toHaveLength(4);
        expect(merged[2]).toEqual(edge[0]);
    });

    test('no-dup concat keeps both legs intact', () => {
        const other = [[62.21, 25.81], [62.1, 25.7]];
        expect(mergeRouteCoords(out, other)).toEqual([...out, ...other]);
    });

    test('missing outbound returns a copy of the return leg', () => {
        const copy = mergeRouteCoords(null, ret);
        expect(copy).toEqual(ret);
        expect(copy).not.toBe(ret);
    });

    test('missing return returns a copy of the outbound leg', () => {
        const copy = mergeRouteCoords(out, undefined);
        expect(copy).toEqual(out);
        expect(copy).not.toBe(out);
    });

    test('both missing yields an empty array', () => {
        expect(mergeRouteCoords(null, null)).toEqual([]);
    });
});

describe('exportGPX', () => {
    test('no-ops with no session', () => {
        exportGPX();
        expect(lastDownload).toBeNull();
        expect(errors).toEqual([]);
    });

    test('empty coords show an error and download nothing', () => {
        globalThis.getCurrentSession = () => ({
            destName: 'Park', routeCoords: [], returnRouteCoords: [],
        });
        exportGPX();
        expect(errors).toEqual(['No route data to export.']);
        expect(lastDownload).toBeNull();
    });

    test('strips <>& from destName rather than escaping them, and emits one trkpt per merged coord', async () => {
        globalThis.getCurrentSession = () => ({
            destName: 'Lake <A> & B',
            routeCoords: [[62.1, 25.7], [62.2, 25.8]],
            returnRouteCoords: [[62.2, 25.8], [62.1, 25.7]],
        });
        exportGPX();

        const xml = await lastBlob.text();
        const name = xml.match(/<name>(.*)<\/name>/)[1];
        // Stripped, not escaped: <>& are gone rather than turned into entities.
        expect(name).toBe('Lake A  B');
        expect(name).not.toMatch(/[<>&]/);
        expect(xml).not.toContain('&amp;');
        expect(xml).not.toContain('&lt;');
        expect(xml.match(/<trkpt /g)).toHaveLength(3);
        expect(lastDownload).toBe('lake-a-b.gpx');
    });

    test('falls back to Wander route when destName is missing', async () => {
        globalThis.getCurrentSession = () => ({
            routeCoords: [[62.1, 25.7], [62.2, 25.8]],
        });
        exportGPX();
        const xml = await lastBlob.text();
        expect(xml).toContain('<name>Wander route</name>');
        expect(xml.match(/<trkpt /g)).toHaveLength(2);
        expect(lastDownload).toBe('wander-route.gpx');
    });
});

describe('openFITModal', () => {
    test('errors when there is no session', () => {
        openFITModal();
        expect(errors).toEqual(['Generate a route first.']);
        expect(document.getElementById('fitModal').classList.contains('active')).toBe(false);
    });

    test('errors when FitEncoder is missing', () => {
        globalThis.getCurrentSession = () => ({ destName: 'Park' });
        delete globalThis.FitEncoder;
        openFITModal();
        expect(errors).toEqual(['FIT encoder not loaded.']);
        expect(document.getElementById('fitModal').classList.contains('active')).toBe(false);
    });

    test('opens the modal when a session and encoder are present', () => {
        globalThis.getCurrentSession = () => ({ destName: 'Park' });
        openFITModal();
        expect(document.getElementById('fitModal').classList.contains('active')).toBe(true);
        expect(errors).toEqual([]);
    });

    test('Escape closes an open modal', () => {
        globalThis.getCurrentSession = () => ({ destName: 'Park' });
        openFITModal();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('fitModal').classList.contains('active')).toBe(false);
    });
});

describe('confirmFITExport', () => {
    function sessionWith(coordsOut, coordsRet = []) {
        return {
            destName: 'Park <X>',
            routeCoords: coordsOut,
            returnRouteCoords: coordsRet,
            routeSteps: [{ name: 'out' }],
            returnRouteSteps: [{ name: 'ret' }],
        };
    }

    test('errors and downloads nothing with no session', async () => {
        await confirmFITExport();
        expect(errors).toEqual(['Generate a route first.']);
        expect(lastDownload).toBeNull();
        expect(FitEncoder.encodeCourse).not.toHaveBeenCalled();
    });

    test('coords.length < 2 errors, closes the modal, and does not download', async () => {
        globalThis.getCurrentSession = () => sessionWith([[62.1, 25.7]]);
        document.getElementById('fitModal').classList.add('active');
        await confirmFITExport();
        expect(errors).toEqual(['No route data to export.']);
        expect(lastDownload).toBeNull();
        expect(FitEncoder.encodeCourse).not.toHaveBeenCalled();
        expect(document.getElementById('fitModal').classList.contains('active')).toBe(false);
    });

    test('fetchElevations reject still downloads, with elevations null', async () => {
        globalThis.getCurrentSession = () => sessionWith(
            [[62.1, 25.7], [62.2, 25.8]],
            [[62.2, 25.8], [62.1, 25.7]],
        );
        globalThis.fetchElevations = vi.fn(() => Promise.reject(new Error('Open-Meteo down')));
        await confirmFITExport();

        expect(errors).toEqual([]);
        expect(lastDownload).toBe('park-x.fit');
        expect(FitEncoder.encodeCourse).toHaveBeenCalledTimes(1);
        const arg = FitEncoder.encodeCourse.mock.calls[0][0];
        expect(arg.elevations).toBeNull();
        expect(arg.coords).toHaveLength(3);
        expect(arg.name).toBe('Park <X>');
        expect(FitEncoder.osrmStepsToCoursePoints).toHaveBeenCalledWith(
            arg.coords,
            [{ name: 'out' }, { name: 'ret' }],
        );
    });

    test('successful elevations are forwarded to encodeCourse', async () => {
        const elev = [11, 22, 33];
        globalThis.getCurrentSession = () => sessionWith(
            [[62.1, 25.7], [62.2, 25.8]],
            [[62.2, 25.8], [62.1, 25.7]],
        );
        globalThis.fetchElevations = vi.fn(() => Promise.resolve(elev));
        await confirmFITExport();
        expect(FitEncoder.encodeCourse.mock.calls[0][0].elevations).toBe(elev);
        expect(lastDownload).toBe('park-x.fit');
    });

    test('drops elevations whose length does not match the exported coords', async () => {
        const coordsOut = [[62.1, 25.7], [62.2, 25.8], [62.3, 25.9]];
        globalThis.getCurrentSession = () => sessionWith(coordsOut);
        // Sampled Open-Meteo series: 2 values for 3 coords. Forwarding this
        // verbatim is the production bug — encodeCourse would stamp the rest
        // as sea level. confirmFITExport must drop them instead.
        globalThis.fetchElevations = vi.fn(() => Promise.resolve([11, 22]));
        await confirmFITExport();
        expect(FitEncoder.encodeCourse.mock.calls[0][0].elevations).toBeNull();
        expect(lastDownload).toBe('park-x.fit');
    });

    // Finding #7302: the suites above stub fetchElevations to matching-length
    // arrays, so a downsample/full-coords glue error cannot fail them. Load
    // the real sampler (fetch mocked) and assert the encoder sees one altitude
    // per exported coord.
    test('real fetchElevations interpolates a long polyline to encodeCourse', async () => {
        loadScripts('elevation');
        const n = 400;
        const coordsOut = Array.from({ length: n }, (_, i) => [62.1 + i * 0.001, 25.7]);
        globalThis.getCurrentSession = () => sessionWith(coordsOut);
        globalThis.fetch = vi.fn((url) => {
            const nLats = new URL(url).searchParams.get('latitude').split(',').length;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    elevation: Array.from({ length: nLats }, (_, i) => 50 + i),
                }),
            });
        });

        await confirmFITExport();

        const arg = FitEncoder.encodeCourse.mock.calls[0][0];
        expect(arg.coords).toHaveLength(n);
        expect(arg.elevations).toHaveLength(n);
        expect(arg.elevations[0]).toBe(50);
        expect(lastDownload).toBe('park-x.fit');
    });
});
