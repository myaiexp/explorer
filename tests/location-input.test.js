// @vitest-environment jsdom
/**
 * Tests for location-input.js — parseLocation, geocodeAddress, resolveStart,
 * and useMyLocation (finding #7064). inFinland is the real bbox.js helper so
 * a broken Finland gate fails here, not only in the browser.
 *
 * fetchWithTimeout / showError are faked on globalThis; bbox.js is loaded for
 * real. Mirrors share-link's parseCoordPair empty-pair trap: '62.1,' must not
 * be treated as a coordinate (lng 0).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse } from './helpers/fetch-stub.js';

loadScripts('bbox', 'location-input');

const JKL = { lat: 62.2416, lng: 25.7209 };       // Jyväskylä — inside
const HEL = { lat: 60.1699, lng: 24.9384 };       // Helsinki — inside
const STO = { lat: 59.3293, lng: 18.0686 };       // Stockholm — outside (lng < 19)

let errors;
let fetchWithTimeout;

beforeEach(() => {
    errors = [];
    document.body.innerHTML =
        '<input id="location">' +
        '<button id="useLocationBtn"></button>';
    globalThis.showError = (msg) => { errors.push(msg); };
    fetchWithTimeout = vi.fn(async () => jsonResponse([{ lat: String(JKL.lat), lon: String(JKL.lng) }]));
    globalThis.fetchWithTimeout = fetchWithTimeout;
});

describe('parseLocation', () => {
    test('parses a lat,lng pair', () => {
        expect(parseLocation('62.2416, 25.7209')).toEqual({
            lat: 62.2416, lng: 25.7209, isAddress: false,
        });
    });

    test('trims whitespace and allows no space after the comma', () => {
        expect(parseLocation('  62.2416,25.7209  ')).toEqual({
            lat: 62.2416, lng: 25.7209, isAddress: false,
        });
    });

    test('accepts the lat/lng range edges', () => {
        expect(parseLocation('90, 180')).toMatchObject({ lat: 90, lng: 180, isAddress: false });
        expect(parseLocation('-90, -180')).toMatchObject({ lat: -90, lng: -180, isAddress: false });
    });

    test.each([
        ['lat above 90', '91, 0'],
        ['lat below -90', '-91, 0'],
        ['lng above 180', '0, 181'],
        ['lng below -180', '0, -181'],
    ])('rejects out-of-range coords: %s', (_label, input) => {
        expect(() => parseLocation(input)).toThrow(/Latitude must be between -90 and 90/);
    });

    test('an address falls through rather than matching the coord regex', () => {
        expect(parseLocation('Jyväskylä')).toEqual({ address: 'Jyväskylä', isAddress: true });
    });

    // Mirror share-link's parseCoordPair: Number('') is 0, so a half-empty pair
    // must not parse as lng 0. The coord regex requires digits on both sides.
    test("half-empty '62.1,' is an address, not a coordinate", () => {
        expect(parseLocation('62.1,')).toEqual({ address: '62.1,', isAddress: true });
        expect(parseLocation('62.1, ')).toEqual({ address: '62.1,', isAddress: true });
    });
});

describe('geocodeAddress', () => {
    test('returns the first Nominatim hit and encodes the query', async () => {
        const result = await geocodeAddress('Jyväskylä market');
        expect(result).toEqual(JKL);
        expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        const url = fetchWithTimeout.mock.calls[0][0];
        expect(url).toContain('https://nominatim.openstreetmap.org/search?format=json&q=');
        expect(url).toContain(encodeURIComponent('Jyväskylä market'));
    });

    test('empty results throw a user-facing miss', async () => {
        fetchWithTimeout.mockResolvedValue(jsonResponse([]));
        await expect(geocodeAddress('Nowhereville')).rejects.toThrow(
            'Could not find location: "Nowhereville"',
        );
    });

    test('a throttled Nominatim response throws a user-facing busy message, not a JSON parse error', async () => {
        fetchWithTimeout.mockResolvedValue({
            ok: false,
            status: 429,
            json: async () => { throw new Error('Unexpected token < in JSON'); },
        });
        await expect(geocodeAddress('Jyväskylä')).rejects.toThrow(
            'Address lookup is busy — try again in a moment, or use coordinates.',
        );
    });

    test('a non-array success body is a miss, not a crash on data[0]', async () => {
        fetchWithTimeout.mockResolvedValue(jsonResponse({ error: 'quota' }));
        await expect(geocodeAddress('Jyväskylä')).rejects.toThrow(
            'Could not find location: "Jyväskylä"',
        );
    });
});

describe('resolveStart', () => {
    test('empty field throws before parsing', async () => {
        document.getElementById('location').value = '   ';
        await expect(resolveStart()).rejects.toThrow('Please enter a starting location.');
        expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    test('Finland coords resolve without geocoding', async () => {
        document.getElementById('location').value = `${HEL.lat}, ${HEL.lng}`;
        await expect(resolveStart()).resolves.toEqual({
            startLat: HEL.lat, startLng: HEL.lng,
            locationInput: `${HEL.lat}, ${HEL.lng}`,
        });
        expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    test('coords outside Finland are a hard stop', async () => {
        document.getElementById('location').value = `${STO.lat}, ${STO.lng}`;
        await expect(resolveStart()).rejects.toThrow(/only routes within Finland/);
        expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    test('an address geocodes, then passes the Finland gate', async () => {
        document.getElementById('location').value = 'Jyväskylä';
        await expect(resolveStart()).resolves.toEqual({
            startLat: JKL.lat, startLng: JKL.lng, locationInput: 'Jyväskylä',
        });
        expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    test('a geocode that lands outside Finland still hard-stops', async () => {
        fetchWithTimeout.mockResolvedValue(jsonResponse([{ lat: String(STO.lat), lon: String(STO.lng) }]));
        document.getElementById('location').value = 'Stockholm';
        await expect(resolveStart()).rejects.toThrow(/only routes within Finland/);
    });

    test("half-empty '62.1,' goes through geocode, not the coord branch", async () => {
        document.getElementById('location').value = '62.1,';
        await resolveStart();
        expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(fetchWithTimeout.mock.calls[0][0]).toContain(encodeURIComponent('62.1,'));
    });
});

describe('useMyLocation', () => {
    test('errors when geolocation is unsupported and does not disable the button', () => {
        const geo = navigator.geolocation;
        Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
        useMyLocation();
        expect(errors).toEqual(['Geolocation is not supported by your browser.']);
        expect(document.getElementById('useLocationBtn').disabled).toBe(false);
        Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    });

    test('writes the device coords into the location field', () => {
        const btn = document.getElementById('useLocationBtn');
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition(ok, _err, opts) {
                    expect(btn.disabled).toBe(true);
                    expect(opts).toEqual({ timeout: 10000 });
                    ok({ coords: { latitude: 62.2416, longitude: 25.7209 } });
                },
            },
        });
        useMyLocation();
        expect(document.getElementById('location').value).toBe('62.241600, 25.720900');
        expect(btn.disabled).toBe(false);
        expect(errors).toEqual([]);
    });

    test('geolocation failure surfaces and re-enables the button', () => {
        const btn = document.getElementById('useLocationBtn');
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition(_ok, err) {
                    err({ message: 'denied' });
                },
            },
        });
        useMyLocation();
        expect(errors).toEqual(['Could not get your location: denied']);
        expect(btn.disabled).toBe(false);
    });
});
