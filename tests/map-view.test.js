// @vitest-environment jsdom
/**
 * Tests for map-view.js — the visited-layer render guard, layer bookkeeping
 * (clearMap / clearRouteLines), and getRouteColor fallback. Finding #7306:
 * nothing previously loaded this module (SCRIPT_DEPS fakes it for route-view;
 * visit-shape.test.js covers visitRenderParts in isolation) so a refactor that
 * dereferenced visit.distance again would pass the rest of the suite while
 * aborting app.js init on every page load.
 *
 * Leaflet is stubbed; visit-shape.js is real. storage.js is not loaded —
 * getVisits is a call-time global, stubbed per test.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const DEFAULT_COLOR = '#E66100';

function validRow(over = {}) {
    return {
        id: 'v1',
        date: '2026-07-01T08:30:00.000Z',
        startLat: 62.24,
        startLng: 25.75,
        startLabel: 'Jyväskylä',
        destLat: 62.28,
        destLng: 25.8,
        destName: 'Harju',
        tripMode: 'round',
        distance: 4.2,
        routeCoords: [[62.24, 25.75], [62.28, 25.8]],
        returnRouteCoords: null,
        ...over,
    };
}

function layer(type, extra = {}) {
    return {
        type,
        ...extra,
        addTo(target) {
            this.parent = target;
            target.addLayer(this);
            return this;
        },
        bindPopup(html) {
            this.popup = html;
            return this;
        },
        setStyle(style) {
            this.options = { ...this.options, ...style };
            return this;
        },
        setIcon(icon) {
            this.icon = icon;
            return this;
        },
    };
}

function container() {
    const layers = new Set();
    return {
        _layers: layers,
        addLayer(l) { layers.add(l); },
        removeLayer(l) { layers.delete(l); },
        clearLayers() { layers.clear(); },
        layers() { return [...layers]; },
        ofType(type) { return [...layers].filter((l) => l.type === type); },
    };
}

let leaflet;
let warn;

function installLeafletStub() {
    const map = {
        ...container(),
        setView(center, zoom) {
            this.center = center;
            this.zoom = zoom;
            return this;
        },
    };
    const created = { polylines: [], markers: [], circles: [], circleMarkers: [], layerGroups: [] };
    globalThis.L = {
        tileLayer: (url, options) => layer('tileLayer', { url, options }),
        map: () => map,
        control: { layers: (bases) => layer('control', { bases }) },
        layerGroup: () => {
            const group = { type: 'layerGroup', ...container() };
            group.addTo = function addTo(target) {
                this.parent = target;
                target.addLayer(this);
                return this;
            };
            created.layerGroups.push(group);
            return group;
        },
        polyline: (coords, options) => {
            const l = layer('polyline', { coords, options: { ...options } });
            created.polylines.push(l);
            return l;
        },
        circleMarker: (latlng, options) => {
            const l = layer('circleMarker', { latlng, options: { ...options } });
            created.circleMarkers.push(l);
            return l;
        },
        marker: (latlng, options) => {
            const l = layer('marker', { latlng, options: { ...options } });
            created.markers.push(l);
            return l;
        },
        circle: (latlng, options) => {
            const l = layer('circle', { latlng, options: { ...options } });
            created.circles.push(l);
            return l;
        },
        divIcon: (opts) => ({ type: 'divIcon', ...opts }),
    };
    leaflet = { map, created };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="map"></div>';
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installLeafletStub();
    globalThis.getVisits = () => [];
    loadScripts('visit-shape', 'map-view');
});

afterEach(() => {
    warn.mockRestore();
});

describe('renderVisitedLayer', () => {
    test('skips a malformed row, draws the good ones, and warns once instead of throwing', () => {
        // Two drawable rows sandwich a row visitRenderParts rejects (no start/dest).
        // The unguarded .distance.toFixed path used to throw here and abort init.
        globalThis.getVisits = () => [
            validRow({ id: 'good-a', startLabel: 'A' }),
            { destName: 'broken', distance: 'far' },
            validRow({
                id: 'good-b',
                startLat: 61.5,
                startLng: 23.8,
                destLat: 61.51,
                destLng: 23.81,
                startLabel: 'B',
                routeCoords: [[61.5, 23.8], [61.51, 23.81]],
            }),
        ];

        expect(() => renderVisitedLayer()).not.toThrow();

        const group = visitedLayerGroup;
        expect(group.ofType('circleMarker')).toHaveLength(4);
        expect(group.ofType('polyline')).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/skipped 1 unusable visit row/);
    });

    test('a stored row with no distance still draws (the init-brick dereference)', () => {
        globalThis.getVisits = () => [validRow({ distance: undefined })];
        expect(() => renderVisitedLayer()).not.toThrow();
        expect(visitedLayerGroup.ofType('circleMarker')).toHaveLength(2);
        expect(warn).not.toHaveBeenCalled();
        const destPopup = visitedLayerGroup.ofType('circleMarker')
            .map((m) => m.popup)
            .find((p) => p.startsWith('<br>'));
        expect(destPopup).toBeDefined();
    });

    test('escapes HTML in the start-label popup', () => {
        const poison = '<img src=x onerror=alert(1)>';
        globalThis.getVisits = () => [validRow({ startLabel: poison })];
        renderVisitedLayer();
        const popups = visitedLayerGroup.ofType('circleMarker').map((m) => m.popup);
        expect(popups.some((p) => p.includes('&lt;img src=x onerror=alert(1)&gt;'))).toBe(true);
        expect(popups.some((p) => p.includes('<img'))).toBe(false);
    });

    test('a second render replaces the overlay instead of stacking', () => {
        globalThis.getVisits = () => [validRow()];
        renderVisitedLayer();
        renderVisitedLayer();
        expect(visitedLayerGroup.ofType('circleMarker')).toHaveLength(2);
        expect(visitedLayerGroup.ofType('polyline')).toHaveLength(1);
    });
});

describe('clearMap / clearRouteLines', () => {
    function drawSession() {
        drawRouteGlow([[62.1, 25.7], [62.2, 25.8]], DEFAULT_COLOR);
        addStartMarker(62.1, 25.7, 'here');
        addDestMarker(62.2, 25.8, DEFAULT_COLOR);
        addRadiusCircles(62.1, 25.7, 5, 1);
    }

    test('clearRouteLines removes only the polylines, keeping markers and circles', () => {
        drawSession();
        const map = leaflet.map;
        expect(map.ofType('polyline')).toHaveLength(2);
        expect(map.ofType('marker')).toHaveLength(2);
        expect(map.ofType('circle')).toHaveLength(2);

        clearRouteLines();

        expect(map.ofType('polyline')).toHaveLength(0);
        expect(map.ofType('marker')).toHaveLength(2);
        expect(map.ofType('circle')).toHaveLength(2);
        expect(map.ofType('layerGroup')).toHaveLength(1);
        expect(map.ofType('tileLayer')).toHaveLength(1);
    });

    test('clearMap removes markers, circles and polylines, leaving base layers', () => {
        drawSession();
        clearMap();

        const map = leaflet.map;
        expect(map.ofType('polyline')).toHaveLength(0);
        expect(map.ofType('marker')).toHaveLength(0);
        expect(map.ofType('circle')).toHaveLength(0);
        expect(map.ofType('layerGroup')).toHaveLength(1);
        expect(map.ofType('tileLayer')).toHaveLength(1);
    });
});

describe('getRouteColor', () => {
    test('falls back to the default for an unknown stored hex', () => {
        localStorage.setItem('walk_route_color', '#00ff00');
        expect(getRouteColor()).toBe(DEFAULT_COLOR);
    });

    test('returns a known palette hex as stored', () => {
        localStorage.setItem('walk_route_color', '#56B4E9');
        expect(getRouteColor()).toBe('#56B4E9');
    });

    test('missing storage uses the default', () => {
        expect(getRouteColor()).toBe(DEFAULT_COLOR);
    });
});

describe('applyRouteColor', () => {
    test('recolors live polylines and the dest pin without dropping them', () => {
        drawRouteGlow([[62.1, 25.7], [62.2, 25.8]], DEFAULT_COLOR);
        addDestMarker(62.2, 25.8, DEFAULT_COLOR);
        setRouteColor('#56B4E9');

        applyRouteColor();

        for (const line of leaflet.map.ofType('polyline')) {
            expect(line.options.color).toBe('#56B4E9');
        }
        expect(leaflet.map.ofType('marker').some((m) => m.icon?.html?.includes('#56B4E9'))).toBe(true);
        expect(leaflet.map.ofType('polyline')).toHaveLength(2);
    });
});
