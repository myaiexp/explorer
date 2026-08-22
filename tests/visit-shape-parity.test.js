// @vitest-environment node
/**
 * Drift guard for the visit-row validation caps that exist in two independent
 * deployables:
 *   - visit-shape.js                         (static frontend; no build step)
 *   - server/src/lib/validate-fields.ts
 *     + server/src/lib/route-coords.ts       (VPS explorer-api)
 *
 * Both sides carry reciprocal TWIN comments: MAX_ROUTE_COORDS, the label/name/
 * date length caps, MAX_ID_LEN / SAFE_ID / the dot-segment reject, and the
 * ISO-date prefix regex MUST stay in lockstep so a row that survives
 * normalizeVisit (and therefore reaches the cloud outbox) is one the API will
 * accept. There is no shared package to enforce this, so this test is the
 * enforcement — the sibling of tests/overpass-exclude-parity.test.js and
 * tests/rate-limit-parity.test.js.
 *
 * Two checks, because the copies are not byte-identical adapters:
 *   1. Named constants + the ISO-date prefix regex match across the sources.
 *   2. A shared vector of ids / dates / coord blobs is accepted or rejected
 *      identically at the field-validator layer (idOrNull ↔ parseRowId,
 *      isoDateOrNull ↔ isIsoDate, coordPairsOrNull ↔ assertRouteCoords).
 *
 * Repair policy is deliberately NOT identical — the client truncates over-long
 * labels, stringifies legacy numeric ids, and nulls a bad polyline rather than
 * dropping the walk; the server 400s the same inputs. Those repairs are what
 * keep the outbox from ever holding a row the API would reject, and the
 * round-trip property at the bottom pins that. Empty coord arrays are also
 * excluded from the identical-vector: the client nulls them, the server accepts
 * them, and neither path 400s a persisted row.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadScripts, readScript } from './helpers/load.js';
import {
    MAX_LABEL_LEN,
    MAX_NAME_LEN,
    MAX_DATE_LEN,
    MAX_ID_LEN,
    SAFE_ID,
    parseRowId,
    isIsoDate,
    tooLong,
} from '../server/src/lib/validate-fields.ts';
import { MAX_ROUTE_COORDS, assertRouteCoords } from '../server/src/lib/route-coords.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '1999-01-01T00:00:00.000Z';

let jsSrc;
let fieldsSrc;
let coordsSrc;

beforeAll(() => {
    loadScripts('visit-shape');
    jsSrc = readScript('visit-shape');
    fieldsSrc = readFileSync(join(ROOT, 'server/src/lib/validate-fields.ts'), 'utf8');
    coordsSrc = readFileSync(join(ROOT, 'server/src/lib/route-coords.ts'), 'utf8');
});

function numberConst(src, name) {
    const m = src.match(new RegExp(`(?:const|export const) ${name} = (\\d+)`));
    if (!m) throw new Error(`${name} numeric literal not found — did the format change?`);
    return Number(m[1]);
}

function regexConst(src, name) {
    const m = src.match(new RegExp(`(?:const|export const) ${name} = /(.+)/;`));
    if (!m) throw new Error(`${name} regex literal not found — did the format change?`);
    return m[1];
}

// Both files inline `/^\d{4}-\d{2}-\d{2}/` rather than naming it. Matching the
// literal (not a looser "a regex exists") is what fails RED on a charset tweak.
function isoPrefixLiteral(src, label) {
    const m = src.match(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\//);
    if (!m) throw new Error(`ISO-date prefix regex not found in ${label} — did the format change?`);
    return m[0];
}

function baseRow(over = {}) {
    return {
        id: 'v1',
        date: '2026-07-01T08:30:00.000Z',
        startLat: 62.24,
        startLng: 25.75,
        destLat: 62.28,
        destLng: 25.8,
        distance: 4.2,
        ...over,
    };
}

function clientKeepsId(id) {
    const row = globalThis.normalizeVisit(baseRow({ id }), NOW);
    return row !== null && row.id === id;
}

function serverKeepsId(id) {
    const parsed = parseRowId(id);
    return !('error' in parsed) && parsed.id === id;
}

function clientKeepsDate(date) {
    const row = globalThis.normalizeVisit(baseRow({ date }), NOW);
    return row !== null && row.date === date;
}

function clientStoresCoords(coords) {
    const row = globalThis.normalizeVisit(baseRow({ routeCoords: coords }), NOW);
    return row !== null && row.routeCoords !== null;
}

function serverAcceptsCoords(coords) {
    try {
        assertRouteCoords(coords, 'routeCoords');
        return true;
    } catch {
        return false;
    }
}

describe('visit-shape ↔ server validator parity', () => {
    test('named caps match across the two deployables', () => {
        expect(numberConst(jsSrc, 'MAX_ROUTE_COORDS')).toBe(MAX_ROUTE_COORDS);
        expect(numberConst(jsSrc, 'MAX_LABEL_LEN')).toBe(MAX_LABEL_LEN);
        expect(numberConst(jsSrc, 'MAX_NAME_LEN')).toBe(MAX_NAME_LEN);
        expect(numberConst(jsSrc, 'MAX_DATE_LEN')).toBe(MAX_DATE_LEN);
        expect(numberConst(jsSrc, 'MAX_ID_LEN')).toBe(MAX_ID_LEN);
        // Source extraction agrees with the TS module's runtime value, so a
        // comment-only edit on the server cannot silently desync the import.
        expect(numberConst(coordsSrc, 'MAX_ROUTE_COORDS')).toBe(MAX_ROUTE_COORDS);
        expect(numberConst(fieldsSrc, 'MAX_LABEL_LEN')).toBe(MAX_LABEL_LEN);
        expect(numberConst(fieldsSrc, 'MAX_NAME_LEN')).toBe(MAX_NAME_LEN);
        expect(numberConst(fieldsSrc, 'MAX_DATE_LEN')).toBe(MAX_DATE_LEN);
        expect(numberConst(fieldsSrc, 'MAX_ID_LEN')).toBe(MAX_ID_LEN);
    });

    test('SAFE_ID is the same regex on both sides', () => {
        expect(`/${regexConst(jsSrc, 'SAFE_ID')}/`).toBe(String(SAFE_ID));
        expect(`/${regexConst(fieldsSrc, 'SAFE_ID')}/`).toBe(String(SAFE_ID));
    });

    test('ISO-date prefix regex is byte-identical across both sources', () => {
        expect(isoPrefixLiteral(jsSrc, 'visit-shape.js'))
            .toBe(isoPrefixLiteral(fieldsSrc, 'validate-fields.ts'));
    });
});

describe('shared id vectors (string inputs)', () => {
    // Numeric legacy ids are a client-only repair (stringify); parseRowId
    // requires a string. The outbox never sees the number — normalizeVisit
    // already coerced it — so the lockstep is the string rule.
    const vectors = [
        ['uuid', '0f9c1e7a-3b2d-4c8e-9a11-7d6f5b4c3a21', true],
        ['legacy numeric string', '1714500000000', true],
        ['unreserved tilde', 'a~b', true],
        ['dots inside a name', 'walk.2026.04.27', true],
        ['underscore', 'a_b', true],
        ['hyphen', 'a-b', true],
        ['exactly 128 chars', 'a'.repeat(128), true],
        ['empty', '', false],
        ['over the 128-char cap', 'a'.repeat(129), false],
        ['slash', 'a/b', false],
        ['space', 'id with space', false],
        ['bare dot', '.', false],
        ['traversal segment', '..', false],
        ['dot-only longer', '...', false],
        ['percent escape', '%2e%2e', false],
        ['query fragment', 'id?x=1', false],
        ['plus', 'a+b', false],
        ['at-sign', 'a@b', false],
    ];

    test.each(vectors)('%s', (_label, id, keep) => {
        expect(clientKeepsId(id)).toBe(keep);
        expect(serverKeepsId(id)).toBe(keep);
    });
});

describe('shared date vectors', () => {
    const vectors = [
        ['full ISO with ms', '2026-04-27T10:00:00.123Z', true],
        ['full ISO', '2026-04-27T10:00:00Z', true],
        ['bare date', '2026-04-27', true],
        ['offset', '2026-04-27T10:00:00+03:00', true],
        ['not ISO', 'last tuesday', false],
        ['SQL-ish', 'DROP TABLE visits', false],
        ['empty', '', false],
        ['no YYYY-MM-DD prefix', '27 April 2026', false],
        ['over the date cap', `2026-04-27T10:00:00.000Z${'x'.repeat(20)}`, false],
    ];

    test.each(vectors)('%s', (_label, date, keep) => {
        expect(clientKeepsDate(date)).toBe(keep);
        expect(isIsoDate(date)).toBe(keep);
    });
});

describe('shared coord-blob vectors', () => {
    const atCap = Array.from({ length: MAX_ROUTE_COORDS }, () => [62.2, 25.7]);
    const overCap = Array.from({ length: MAX_ROUTE_COORDS + 1 }, () => [62.2, 25.7]);
    const vectors = [
        ['two points', [[62.2, 25.7], [62.3, 25.8]], true],
        ['exactly at the cap', atCap, true],
        ['one over the cap', overCap, false],
        ['lat out of range', [[999, 0]], false],
        ['lng out of range', [[0, 999]], false],
        ['short pair', [[62.2]], false],
        ['not an array', 'nope', false],
        ['pair with a string', [[62.2, 'x']], false],
    ];

    test.each(vectors)('%s', (_label, coords, ok) => {
        expect(clientStoresCoords(coords)).toBe(ok);
        expect(serverAcceptsCoords(coords)).toBe(ok);
    });
});

describe('outbox contract: a normalized row is one the API will accept', () => {
    // The data-loss case the TWIN comments exist for: import repairs locally,
    // queues the result, and the PUT/import 400s if the repairs didn't land
    // inside the server caps. Drive dirty rows through normalizeVisit and
    // assert every surviving field passes the server validators.
    const dirty = [
        baseRow(),
        baseRow({ id: 17 }),
        baseRow({ id: '..' }),
        baseRow({ startLabel: 'x'.repeat(MAX_LABEL_LEN + 1) }),
        baseRow({ destName: 'y'.repeat(MAX_NAME_LEN + 1) }),
        baseRow({ tripMode: 'z'.repeat(MAX_LABEL_LEN + 1) }),
        baseRow({ poiCategory: 'p'.repeat(MAX_LABEL_LEN + 1) }),
        baseRow({ date: 'last tuesday' }),
        baseRow({ routeCoords: 'nope' }),
        baseRow({ routeCoords: Array.from({ length: MAX_ROUTE_COORDS + 1 }, () => [62.2, 25.7]) }),
        baseRow({
            startLat: '62.24', startLng: '25.75',
            destLat: '62.28', destLng: '25.8', distance: '4.2',
        }),
    ];

    test('every field normalizeVisit emits is server-acceptable', () => {
        for (const input of dirty) {
            const row = globalThis.normalizeVisit(input, NOW);
            if (!row) continue;
            const id = row.id ?? '00000000-0000-4000-8000-000000000000';
            expect(parseRowId(id)).toEqual({ id });
            expect(isIsoDate(row.date)).toBe(true);
            expect(tooLong(row.startLabel, MAX_LABEL_LEN)).toBe(false);
            expect(tooLong(row.destName, MAX_NAME_LEN)).toBe(false);
            expect(tooLong(row.tripMode, MAX_LABEL_LEN)).toBe(false);
            expect(tooLong(row.poiCategory, MAX_LABEL_LEN)).toBe(false);
            expect(() => assertRouteCoords(row.routeCoords, 'routeCoords')).not.toThrow();
            expect(() => assertRouteCoords(row.returnRouteCoords, 'returnRouteCoords')).not.toThrow();
        }
    });
});
