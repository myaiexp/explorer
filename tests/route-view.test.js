// @vitest-environment jsdom
/**
 * Tests for route-view.js — displayRoute / renderRouteTail / buildDirectionsUrl
 * / getSpreadParams / updateDurationBadges. Finding #7071: the only prior load
 * of this module was mark-visited.test.js, which stubbed the drawing layer to
 * assert the visited button. These pin the render tail itself.
 *
 * SCRIPT_DEPS pulls session-state, geometry, result-panel. session.js is loaded
 * extra so computeRouteTotals / routeSessionFields are real. map-view /
 * elevation / favorites / osrm (loopVias) are faked on globalThis.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const PANEL_HTML = `
  <button id="markVisitedBtn">Mark as visited</button>
  <button id="favoriteBtn"></button>
  <div id="elevationContainer"></div>
  <div id="resultPanel"></div>
  <div id="destName"></div>
  <div id="destCoords"></div>
  <a id="streetViewLink"></a>
  <a id="directionsLink"></a>
  <span id="distanceBadge"></span>
  <span id="walkBadge"></span>
  <span id="bikeBadge"></span>
  <span id="carBadge"></span>
  <select id="locationTypeSelect"><option value="park">park</option></select>
  <input id="spreadSlider" type="range" value="50">`;

const START = { lat: 62.1, lng: 25.7 };
const DEST  = { lat: 62.2, lng: 25.8 };
const COLOR = '#ff0000';

const RIGHT = [
    { lat: 62.12, lng: 25.72 },
    { lat: 62.15, lng: 25.75 },
    { lat: 62.18, lng: 25.78 },
];
const LEFT = [
    { lat: 62.11, lng: 25.71 },
    { lat: 62.14, lng: 25.74 },
    { lat: 62.17, lng: 25.77 },
];

beforeEach(() => {
    document.body.innerHTML = PANEL_HTML;
    globalThis.updateFavoriteBtn = () => {};
    globalThis.getRouteColor = () => COLOR;
    globalThis.addStartMarker = vi.fn();
    globalThis.addDestMarker = vi.fn();
    globalThis.addRadiusCircles = vi.fn();
    globalThis.fetchElevations = vi.fn(() => Promise.resolve([]));
    globalThis.renderElevationChart = vi.fn();
    globalThis.loopVias = vi.fn(() => ({ rightVias: RIGHT, leftVias: LEFT }));
    globalThis.drawRouteGlow = vi.fn();
    globalThis.drawRoutePair = vi.fn((outbound, ret) => {
        const all = [];
        if (outbound?.coords) all.push(...outbound.coords);
        if (ret?.coords) all.push(...ret.coords);
        return all;
    });
    globalThis.map = { fitBounds: vi.fn() };
    globalThis.L = { latLngBounds: (coords) => ({ pad: (n) => ({ coords, n }) }) };
    loadScripts('route-view', 'session');
});

function waypoint(p) {
    return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

describe('getSpreadParams', () => {
    test('reads the slider and forwards the integer to computeSpreadParams', () => {
        document.getElementById('spreadSlider').value = '0';
        expect(getSpreadParams()).toEqual(computeSpreadParams(0));
        document.getElementById('spreadSlider').value = '100';
        expect(getSpreadParams()).toEqual(computeSpreadParams(100));
        document.getElementById('spreadSlider').value = '50';
        expect(getSpreadParams()).toEqual(computeSpreadParams(50));
    });
});

describe('updateDurationBadges', () => {
    test('one-way vs round-trip copy', () => {
        updateDurationBadges(3.2, 1800, 'one-way');
        expect(document.getElementById('distanceBadge').textContent).toBe('3.2 km one way');
        updateDurationBadges(6.4, 3600, 'round');
        expect(document.getElementById('distanceBadge').textContent).toBe('6.4 km round trip');
    });

    test('walk badge hides when duration is 0 and shows minutes otherwise', () => {
        updateDurationBadges(3, 0, 'round');
        expect(document.getElementById('walkBadge').style.display).toBe('none');
        updateDurationBadges(3, 1800, 'round');
        expect(document.getElementById('walkBadge').textContent).toBe('🚶 ~30 min');
        expect(document.getElementById('walkBadge').style.display).toBe('inline-block');
    });
});

describe('buildDirectionsUrl', () => {
    test('one-way has origin→dest and no waypoints', () => {
        const url = buildDirectionsUrl(START.lat, START.lng, DEST.lat, DEST.lng, 'one-way');
        expect(url).toContain('origin=62.1,25.7');
        expect(url).toContain('destination=62.2,25.8');
        expect(url).not.toContain('waypoints=');
        expect(loopVias).not.toHaveBeenCalled();
    });

    test('round-trip waypoints equal loopVias right + dest + reversed left', () => {
        const url = buildDirectionsUrl(START.lat, START.lng, DEST.lat, DEST.lng, 'round');
        const expected = [
            ...RIGHT.map(waypoint),
            waypoint(DEST),
            ...LEFT.slice().reverse().map(waypoint),
        ].join('|');
        expect(url).toContain(`origin=${START.lat},${START.lng}`);
        expect(url).toContain(`destination=${START.lat},${START.lng}`);
        expect(url).toContain(`waypoints=${expected}`);
        expect(loopVias).toHaveBeenCalledWith(
            START.lat, START.lng, DEST.lat, DEST.lng, getSpreadParams(),
        );
    });
});

describe('renderRouteTail — fallbackStraight', () => {
    const args = () => [START.lat, START.lng, DEST.lat, DEST.lng, null, null, 'round', COLOR];

    test('draws a dashed straight line when both legs are missing and fallbackStraight is true', () => {
        renderRouteTail(...args(), { fallbackStraight: true });
        expect(drawRouteGlow).toHaveBeenCalledTimes(1);
        expect(drawRouteGlow).toHaveBeenCalledWith(
            [[START.lat, START.lng], [DEST.lat, DEST.lng]],
            COLOR,
            { dashed: true },
        );
        expect(map.fitBounds).toHaveBeenCalledTimes(1);
    });

    test('does not draw the dashed line when fallbackStraight is false', () => {
        renderRouteTail(...args(), { fallbackStraight: false });
        expect(drawRouteGlow).not.toHaveBeenCalled();
        expect(map.fitBounds).not.toHaveBeenCalled();
    });

    test('does not draw the dashed line when a leg produced coords', () => {
        const outbound = { coords: [[START.lat, START.lng], [DEST.lat, DEST.lng]], distance: 1000, duration: 600 };
        renderRouteTail(START.lat, START.lng, DEST.lat, DEST.lng, outbound, null, 'round', COLOR, { fallbackStraight: true });
        expect(drawRouteGlow).not.toHaveBeenCalled();
        expect(drawRoutePair).toHaveBeenCalledWith(outbound, null, COLOR);
    });

    test('undefined legs are treated like missing (generate.js failed-smart-build path)', () => {
        renderRouteTail(START.lat, START.lng, DEST.lat, DEST.lng, undefined, undefined, 'round', COLOR, { fallbackStraight: true });
        expect(drawRouteGlow).toHaveBeenCalledWith(
            [[START.lat, START.lng], [DEST.lat, DEST.lng]],
            COLOR,
            { dashed: true },
        );
    });
});

describe('displayRoute', () => {
    const displayed = (over = {}) => displayRoute({
        startLat: START.lat, startLng: START.lng,
        destLat: DEST.lat, destLng: DEST.lng,
        outbound: null, ret: null, locationInput: 'Jyväskylä',
        destName: 'Park', tripMode: 'round', ...over,
    });

    test('destName uses textContent — HTML in the name is not injected', () => {
        const poison = '<img src=x onerror="alert(1)">';
        displayed({ destName: poison });
        const nameEl = document.getElementById('destName');
        expect(nameEl.querySelector('img')).toBeNull();
        const a = nameEl.querySelector('a');
        expect(a).not.toBeNull();
        expect(a.textContent).toBe(poison);
        expect(a.href).toContain(encodeURIComponent(poison));
        expect(nameEl.style.display).toBe('block');
    });

    test('missing destName hides the name slot', () => {
        displayed({ destName: null });
        const nameEl = document.getElementById('destName');
        expect(nameEl.style.display).toBe('none');
        expect(nameEl.childNodes).toHaveLength(0);
    });

    test('one-way badge copy goes through the render tail', () => {
        const outbound = { coords: [[START.lat, START.lng]], distance: 3200, duration: 1800 };
        displayed({ outbound, tripMode: 'one-way' });
        expect(document.getElementById('distanceBadge').textContent).toBe('3.2 km one way');
    });

    test('round-trip badge copy with no legs uses the straight-line double', () => {
        displayed({ tripMode: 'round' });
        const straight = calculateDistance(START.lat, START.lng, DEST.lat, DEST.lng);
        expect(document.getElementById('distanceBadge').textContent)
            .toBe(`${(straight * 2).toFixed(1)} km round trip`);
    });

    test('displayRoute always requests the straight-line fallback (first render)', () => {
        displayed();
        expect(drawRouteGlow).toHaveBeenCalledWith(
            [[START.lat, START.lng], [DEST.lat, DEST.lng]],
            COLOR,
            { dashed: true },
        );
    });

    // Finding #7311: poiCategory used to be read off #locationTypeSelect, so
    // restore / pick-on-map / share-link stamped whatever the form currently
    // showed. The session field is now an explicit argument; the live dropdown
    // is only the generate path's input, forwarded by generate.js.
    test('stamps the passed poiCategory onto the session, ignoring the dropdown', () => {
        document.getElementById('locationTypeSelect').innerHTML =
            '<option value="food" selected>food</option>';
        displayed({ poiCategory: 'nature' });
        expect(getCurrentSession().poiCategory).toBe('nature');
    });

    test('omitted poiCategory is null even when the dropdown has a value', () => {
        expect(document.getElementById('locationTypeSelect').value).toBe('park');
        displayed();
        expect(getCurrentSession().poiCategory).toBeNull();
    });

    test('explicit null poiCategory stays null', () => {
        displayed({ poiCategory: null });
        expect(getCurrentSession().poiCategory).toBeNull();
    });
});
