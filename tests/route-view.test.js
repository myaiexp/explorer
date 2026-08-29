// @vitest-environment jsdom
/**
 * Tests for route-view.js — displayRoute / renderRouteTail / buildDirectionsUrl
 * / getSpreadParams / readRouteBuildOptions / syncDistanceLabel /
 * updateDurationBadges. Finding #7071: the only prior load of this module was
 * mark-visited.test.js, which stubbed the drawing layer to assert the visited
 * button. These pin the render tail itself. Findings #7321 / #7316: the
 * routing-mode form reads that used to be copy-pasted at three UI call sites.
 *
 * SCRIPT_DEPS pulls session-state, geometry, result-panel. session.js is loaded
 * extra so computeRouteTotals / routeSessionFields are real. map-view /
 * elevation / favorites / osrm (loopVias) are faked on globalThis.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
  <input id="spreadSlider" type="range" value="50">
  <input type="checkbox" id="smartRouting">
  <input type="checkbox" id="winterMode">
  <input id="maxDistance" value="5">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <label id="distanceLabel">Round-trip distance (km)</label>`;

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
    globalThis.isSelfHostedDown = vi.fn(() => false);
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

describe('readRouteBuildOptions', () => {
    function setModes({ smart = false, winter = false, maxKm = '5', spread = '50' } = {}) {
        document.getElementById('smartRouting').checked = smart;
        document.getElementById('winterMode').checked = winter;
        document.getElementById('maxDistance').value = maxKm;
        document.getElementById('spreadSlider').value = spread;
    }

    test('round-trip + both checkboxes → smart and winter on, spread from the slider', () => {
        setModes({ smart: true, winter: true, maxKm: '12.5', spread: '100' });
        expect(readRouteBuildOptions('round')).toEqual({
            tripMode: 'round',
            smartRouting: true,
            winterMode: true,
            maxKm: 12.5,
            spread: computeSpreadParams(100),
            degraded: false,
        });
    });

    test('readRouteBuildOptions reports degraded when the latch is live', () => {
        globalThis.isSelfHostedDown = vi.fn(() => true);
        expect(readRouteBuildOptions('round').degraded).toBe(true);
    });

    test('readRouteBuildOptions reports degraded false when self-hosted is healthy', () => {
        globalThis.isSelfHostedDown = vi.fn(() => false);
        expect(readRouteBuildOptions('round').degraded).toBe(false);
    });

    test('one-way never enables smart routing, even when both checkboxes are on', () => {
        setModes({ smart: true, winter: true });
        const opts = readRouteBuildOptions('one-way');
        expect(opts.tripMode).toBe('one-way');
        expect(opts.smartRouting).toBe(false);
        // Dest-pool winter filtering is independent of smart routing (the
        // checkbox hint says so); dispatch already ignores winterMode unless
        // it takes the smart-loop branch, so the helper does not re-gate it.
        expect(opts.winterMode).toBe(true);
    });

    test('round-trip + winter without smart still reports winterMode (dest-pool)', () => {
        setModes({ smart: false, winter: true });
        const opts = readRouteBuildOptions('round');
        expect(opts.smartRouting).toBe(false);
        expect(opts.winterMode).toBe(true);
    });

    test('round-trip + smart without winter → winterMode false', () => {
        setModes({ smart: true, winter: false });
        const opts = readRouteBuildOptions('round');
        expect(opts.smartRouting).toBe(true);
        expect(opts.winterMode).toBe(false);
    });
});

describe('syncDistanceLabel', () => {
    test('one-way vs round-trip copy', () => {
        document.getElementById('oneWay').checked = true;
        document.getElementById('roundTrip').checked = false;
        syncDistanceLabel();
        expect(document.getElementById('distanceLabel').textContent).toBe('One-way distance (km)');

        document.getElementById('oneWay').checked = false;
        document.getElementById('roundTrip').checked = true;
        syncDistanceLabel();
        expect(document.getElementById('distanceLabel').textContent).toBe('Round-trip distance (km)');
    });
});

describe('routing-mode form policy has a single owner (findings #7321 / #7316)', () => {
    const root = resolve(__dirname, '..');
    const src = (name) => readFileSync(resolve(root, name), 'utf8');

    test('callers do not re-read smartRouting / winterMode from the DOM', () => {
        for (const file of ['route-restore.js', 'spread-control.js', 'generate.js']) {
            expect(src(file), file).not.toMatch(/getElementById\('smartRouting'\)/);
            expect(src(file), file).not.toMatch(/getElementById\('winterMode'\)/);
        }
    });

    test('distance-label strings live only in syncDistanceLabel', () => {
        for (const file of ['form-controls.js', 'settings.js']) {
            expect(src(file), file).not.toMatch(/One-way distance \(km\)/);
            expect(src(file), file).not.toMatch(/Round-trip distance \(km\)/);
        }
        expect(src('route-view.js')).toMatch(/One-way distance \(km\)/);
        expect(src('route-view.js')).toMatch(/Round-trip distance \(km\)/);
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

    test('labels the distance badge as straight-line when no route was built', () => {
        renderRouteTail(...args(), { fallbackStraight: true });
        expect(document.getElementById('distanceBadge').textContent).toMatch(/straight line/i);
    });

    test('hides the bike and car badges when no route was built', () => {
        renderRouteTail(...args(), { fallbackStraight: true });
        expect(document.getElementById('bikeBadge').style.display).toBe('none');
        expect(document.getElementById('carBadge').style.display).toBe('none');
    });

    test('a later real route restores the bike and car badges', () => {
        renderRouteTail(...args(), { fallbackStraight: true });
        const outbound = { coords: [[START.lat, START.lng], [DEST.lat, DEST.lng]], distance: 3200, duration: 2400 };
        renderRouteTail(START.lat, START.lng, DEST.lat, DEST.lng, outbound, null, 'round', COLOR, { fallbackStraight: true });
        expect(document.getElementById('bikeBadge').style.display).toBe('inline-block');
        expect(document.getElementById('carBadge').style.display).toBe('inline-block');
        expect(document.getElementById('distanceBadge').textContent).not.toMatch(/straight line/i);
    });

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

    test('round-trip badge copy with no legs uses the straight-line double, labelled as such', () => {
        displayed({ tripMode: 'round' });
        const straight = haversineKm(START.lat, START.lng, DEST.lat, DEST.lng);
        // The number is still the crow-flies double (computeRouteTotals is
        // unchanged); what changed is that it no longer claims to be a walk.
        expect(document.getElementById('distanceBadge').textContent)
            .toBe(`~${(straight * 2).toFixed(1)} km straight line`);
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
