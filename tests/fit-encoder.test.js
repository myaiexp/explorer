// @vitest-environment node
/**
 * Tests for fit-encoder.js — Garmin FIT course-file binary encoder.
 * Audit finding #1562: this file had zero test coverage.
 *
 * Loading: fit-encoder.js is a non-module browser IIFE that exposes only
 * { encodeCourse, osrmStepsToCoursePoints, CP } on globalThis. The closure
 * also holds ByteWriter, crc16, toSemicircles, toFitTime, haversine,
 * osrmStepToType and nearestCoordIndex — all of which the audit requires us
 * to test. We read its text via helpers/load.js's readScript() and
 * string-inject an `_internals` export at load time only (the export line is
 * untouched on disk), then evaluate the patched source with evalScript() — the
 * escape hatch loadScripts() itself doesn't cover. If the export line ever
 * changes, the injection throws loudly.
 *
 * `haversine` is now an alias of the canonical globalThis.haversineM (audit
 * #1262), so geo-utils.js must run in the realm first — exactly as it does in
 * the browser load order; helpers/load.js's SCRIPT_DEPS lists geo-utils as
 * fit-encoder's dependency, but since we bypass loadScripts() for the
 * injection, we load geo-utils explicitly ourselves before it. The distance
 * assertions stay self-consistent: the encoder and these tests call the same
 * `internals.haversine` reference.
 *
 * The FIT CRC-16 is exactly CRC-16/ARC (reflected, poly 0xA001, init 0,
 * catalog check value 0xBB3D for "123456789"). We validate the SUT's
 * table-driven crc16 against an independent bitwise CRC-16/ARC reference and
 * the catalog check value, so the CRC tests are not tautological.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts, readScript, evalScript } from './helpers/load.js';

const EXPORT_LINE =
    'global.FitEncoder = { encodeCourse, osrmStepsToCoursePoints, CP };';
const INJECTED =
    'global.FitEncoder = { encodeCourse, osrmStepsToCoursePoints, CP, ' +
    '_internals: { ByteWriter, crc16, writeDefinition, haversine, ' +
    'toSemicircles, toFitTime, osrmStepToType, nearestCoordIndex, ' +
    'FIT_EPOCH, SEMICIRCLE, WALK_MPS, T, M } };';

let enc, internals, CP;

beforeAll(() => {
    loadScripts('geo-utils');   // exposes globalThis.haversineM (aliased by the encoder)
    const RAW = readScript('fit-encoder');
    const SRC = RAW.replace(EXPORT_LINE, INJECTED);
    if (SRC === RAW) throw new Error('injection failed — export line changed in fit-encoder.js');
    evalScript(SRC);
    enc = globalThis.FitEncoder;
    internals = enc._internals;
    CP = enc.CP;
});

// ── independent helpers (no dependency on the SUT) ───────────────────────────

// Bitwise CRC-16/ARC: reflected, poly 0xA001, init 0x0000, xorout 0. This is
// the canonical reference the FIT CRC must match. Implemented from first
// principles, independent of the SUT's nibble-table variant.
function crc16arc_ref(bytes) {
    let crc = 0;
    for (const b of bytes) {
        crc ^= b & 0xFF;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
        }
    }
    return crc & 0xFFFF;
}

const u8a = (arr) => Uint8Array.from(arr);
const readU16LE = (arr) => arr[0] | (arr[1] << 8);
const readI32LE = (arr) => new DataView(u8a(arr).buffer).getInt32(0, true);
const readU32LE = (arr) => new DataView(u8a(arr).buffer).getUint32(0, true);

// Minimal FIT message-stream parser: walks definition + data messages so we
// can assert structure (record counts, field values) instead of byte-scanning.
function parseFit(out) {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const headerSize = out[0];
    const dataSize = view.getUint32(4, true);
    const headerCrc = view.getUint16(12, true);
    const fileCrc = view.getUint16(out.length - 2, true);

    const defs = {};
    const messages = [];
    let pos = headerSize;
    const dataEnd = headerSize + dataSize;
    while (pos < dataEnd) {
        const recHeader = out[pos++];
        const isDef = (recHeader & 0x40) !== 0 && (recHeader & 0x80) === 0;
        const localType = recHeader & 0x0F;
        if (isDef) {
            pos++; pos++; // reserved + architecture
            const globalMesg = view.getUint16(pos, true); pos += 2;
            const numFields = out[pos++];
            const fields = [];
            let totalSize = 0;
            for (let i = 0; i < numFields; i++) {
                const defNum = out[pos++];
                const size = out[pos++];
                const baseType = out[pos++];
                fields.push({ defNum, size, baseType });
                totalSize += size;
            }
            defs[localType] = { globalMesg, fields, totalSize };
        } else {
            const def = defs[localType];
            if (!def) throw new Error('data message before definition: local ' + localType);
            const fieldVals = {};
            let p = pos;
            for (const f of def.fields) {
                fieldVals[f.defNum] = Array.from(out.slice(p, p + f.size));
                p += f.size;
            }
            messages.push({ localType, globalMesg: def.globalMesg, fields: fieldVals });
            pos += def.totalSize;
        }
    }
    return { headerSize, dataSize, headerCrc, fileCrc, messages };
}

// FIT global message numbers (mirror of SUT's M, used only for assertions)
const G = { FILE_ID: 0, FILE_CREATOR: 49, COURSE: 31, LAP: 19, EVENT: 21, RECORD: 20, COURSE_POINT: 32 };

// ── ByteWriter ───────────────────────────────────────────────────────────────

describe('ByteWriter', () => {
    test('u8 writes one little-endian byte and masks to 0xFF', () => {
        const w = internals.ByteWriter();
        w.u8(0x12);
        w.u8(0x1FF); // masked → 0xFF
        expect(Array.from(w.toUint8Array())).toEqual([0x12, 0xFF]);
        expect(w.length()).toBe(2);
    });

    test('u16 writes little-endian and masks to 16 bits', () => {
        const w = internals.ByteWriter();
        w.u16(0x1234);
        w.u16(0x12345); // masked → 0x2345
        expect(Array.from(w.toUint8Array())).toEqual([0x34, 0x12, 0x45, 0x23]);
    });

    test('u32 writes little-endian incl. high bit set', () => {
        const w = internals.ByteWriter();
        w.u32(0x12345678);
        w.u32(0xFFFFFFFF);
        const b = w.toUint8Array();
        expect(readU32LE(Array.from(b.slice(0, 4)))).toBe(0x12345678);
        expect(readU32LE(Array.from(b.slice(4, 8)))).toBe(0xFFFFFFFF);
        expect(Array.from(b.slice(0, 4))).toEqual([0x78, 0x56, 0x34, 0x12]);
    });

    test('i32 roundtrips negatives via twos-complement little-endian', () => {
        const cases = [-1, -2147483648, 2147483647, 0, -715827883];
        for (const v of cases) {
            const w = internals.ByteWriter();
            w.i32(v);
            expect(readI32LE(Array.from(w.toUint8Array()))).toBe(v);
        }
        // -1 is all 0xFF
        const w = internals.ByteWriter();
        w.i32(-1);
        expect(Array.from(w.toUint8Array())).toEqual([0xFF, 0xFF, 0xFF, 0xFF]);
    });

    test('string null-pads to fieldSize', () => {
        const w = internals.ByteWriter();
        w.string('Hi', 5);
        expect(Array.from(w.toUint8Array())).toEqual([0x48, 0x69, 0, 0, 0]);
        expect(w.length()).toBe(5);
    });

    test('string truncates to fieldSize-1 then pads (always null-terminated)', () => {
        const w = internals.ByteWriter();
        w.string('ABCDEF', 4); // keeps 'ABC' (slice 0..3), pads 1 → null term
        expect(Array.from(w.toUint8Array())).toEqual([0x41, 0x42, 0x43, 0x00]);
    });
});

// ── crc16 (FIT CRC-16 == CRC-16/ARC) ─────────────────────────────────────────

describe('crc16', () => {
    test('empty buffer → 0', () => {
        expect(internals.crc16(u8a([]))).toBe(0);
    });

    test('catalog check value: "123456789" → 0xBB3D', () => {
        const bytes = new TextEncoder().encode('123456789');
        // Anchor: our independent reference reproduces the CRC-16/ARC catalog value.
        expect(crc16arc_ref(bytes)).toBe(0xBB3D);
        // SUT's table-driven crc16 must match.
        expect(internals.crc16(bytes)).toBe(0xBB3D);
    });

    test('matches independent bitwise CRC-16/ARC across varied buffers', () => {
        const buffers = [
            [0x00],
            [0xFF],
            [0x00, 0x01, 0x02, 0x03],
            [0x2E, 0x46, 0x49, 0x54], // ".FIT"
            [14, 0x10, 0x5C, 0x08, 0, 0, 0, 0, 0x2E, 0x46, 0x49, 0x54], // FIT header sans CRC
            Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xFF),
        ];
        for (const buf of buffers) {
            expect(internals.crc16(u8a(buf))).toBe(crc16arc_ref(buf));
        }
    });
});

// ── SEMICIRCLE coordinate conversion ─────────────────────────────────────────

describe('SEMICIRCLE / toSemicircles', () => {
    test('SEMICIRCLE constant == 2^31 / 180', () => {
        expect(internals.SEMICIRCLE).toBeCloseTo(11930464.711111, 4);
    });

    test('toSemicircles known value (60° → 715827883)', () => {
        expect(internals.toSemicircles(60.0)).toBe(715827883);
    });

    test('sign is preserved (negative latitude → negative semicircles)', () => {
        expect(internals.toSemicircles(-60.0)).toBe(-715827883);
        expect(internals.toSemicircles(-24.9384)).toBeLessThan(0);
    });

    test('roundtrip: semicircles / SEMICIRCLE recovers degrees', () => {
        for (const deg of [0, 60.1699, 24.9384, -89.5, 179.9]) {
            const back = internals.toSemicircles(deg) / internals.SEMICIRCLE;
            expect(back).toBeCloseTo(deg, 5);
        }
    });
});

// ── FIT epoch ────────────────────────────────────────────────────────────────

describe('FIT_EPOCH / toFitTime', () => {
    test('FIT_EPOCH == 631065600 and is 1989-12-31T00:00:00Z', () => {
        expect(internals.FIT_EPOCH).toBe(631065600);
        expect(new Date(internals.FIT_EPOCH * 1000).toISOString())
            .toBe('1989-12-31T00:00:00.000Z');
    });

    test('toFitTime subtracts the epoch (concrete value, not epoch-derived)', () => {
        // 631066600 unix = epoch + 1000 s
        expect(internals.toFitTime(631066600)).toBe(1000);
    });

    test('toFitTime clamps below the epoch to 0', () => {
        expect(internals.toFitTime(internals.FIT_EPOCH)).toBe(0);
        expect(internals.toFitTime(internals.FIT_EPOCH - 5000)).toBe(0);
        expect(internals.toFitTime(0)).toBe(0);
    });
});

// ── haversine (local copy) ───────────────────────────────────────────────────

describe('haversine', () => {
    // Reference: on a sphere of R=6371000 m, 1° of latitude is R·π/180.
    const ONE_DEG = 6371000 * Math.PI / 180; // ≈ 111194.93 m

    test('1° latitude at the meridian ≈ R·π/180', () => {
        expect(internals.haversine(0, 0, 1, 0)).toBeCloseTo(ONE_DEG, 1);
    });

    test('1° longitude at the equator ≈ R·π/180', () => {
        expect(internals.haversine(0, 0, 0, 1)).toBeCloseTo(ONE_DEG, 1);
    });

    test('identical points → 0', () => {
        expect(internals.haversine(60.17, 24.94, 60.17, 24.94)).toBe(0);
    });

    test('symmetric', () => {
        const a = internals.haversine(60.17, 24.94, 61.50, 23.76);
        const b = internals.haversine(61.50, 23.76, 60.17, 24.94);
        expect(a).toBeCloseTo(b, 6);
    });

    test('Helsinki→Tampere ≈ 161 km (spherical model)', () => {
        const d = internals.haversine(60.1699, 24.9384, 61.4978, 23.7610);
        expect(d / 1000).toBeCloseTo(161.3, 0);
    });
});

// ── osrmStepToType ───────────────────────────────────────────────────────────

describe('osrmStepToType', () => {
    const t = (type, modifier) => internals.osrmStepToType({ maneuver: { type, modifier } });

    test('depart / arrive → null (no course point emitted)', () => {
        expect(t('depart', '')).toBeNull();
        expect(t('arrive', '')).toBeNull();
    });

    test('turn modifiers map to the correct course-point types', () => {
        expect(t('turn', 'left')).toBe(CP.LEFT);
        expect(t('turn', 'right')).toBe(CP.RIGHT);
        expect(t('turn', 'straight')).toBe(CP.STRAIGHT);
        expect(t('turn', 'slight left')).toBe(CP.SLIGHT_LEFT);
        expect(t('turn', 'slight right')).toBe(CP.SLIGHT_RIGHT);
        expect(t('turn', 'sharp left')).toBe(CP.SHARP_LEFT);
        expect(t('turn', 'sharp right')).toBe(CP.SHARP_RIGHT);
        expect(t('turn', 'uturn')).toBe(CP.U_TURN);
    });

    test('fork maps by side, defaulting to middle', () => {
        expect(t('fork', 'left')).toBe(CP.LEFT_FORK);
        expect(t('fork', 'right')).toBe(CP.RIGHT_FORK);
        expect(t('fork', '')).toBe(CP.MIDDLE_FORK);
        expect(t('fork', 'slight right')).toBe(CP.RIGHT_FORK); // includes('right')
    });

    test('unknown / missing modifier → GENERIC', () => {
        expect(t('turn', 'banana')).toBe(CP.GENERIC);
        expect(t('new name', '')).toBe(CP.GENERIC);
        expect(internals.osrmStepToType(null)).toBe(CP.GENERIC);
        expect(internals.osrmStepToType({})).toBe(CP.GENERIC);
    });
});

// ── nearestCoordIndex ────────────────────────────────────────────────────────

describe('nearestCoordIndex', () => {
    const coords = [[60.10, 24.90], [60.20, 24.90], [60.30, 24.90]];

    test('returns the index of the closest coordinate', () => {
        expect(internals.nearestCoordIndex(coords, 60.19, 24.90)).toBe(1);
        expect(internals.nearestCoordIndex(coords, 60.31, 24.90)).toBe(2);
        expect(internals.nearestCoordIndex(coords, 60.05, 24.90)).toBe(0);
    });

    test('exact match returns that index', () => {
        expect(internals.nearestCoordIndex(coords, 60.20, 24.90)).toBe(1);
    });
});

// ── osrmStepsToCoursePoints ──────────────────────────────────────────────────

describe('osrmStepsToCoursePoints', () => {
    const coords = [[60.10, 24.90], [60.20, 24.90], [60.30, 24.90]];

    test('empty / missing steps → []', () => {
        expect(enc.osrmStepsToCoursePoints(coords, [])).toEqual([]);
        expect(enc.osrmStepsToCoursePoints(coords, null)).toEqual([]);
    });

    test('drops depart/arrive and steps without a location; snaps to nearest', () => {
        const steps = [
            { name: 'Start St', maneuver: { type: 'depart', modifier: '', location: [24.90, 60.10] } },
            { name: 'Main Rd', maneuver: { type: 'turn', modifier: 'left', location: [24.90, 60.20] } },
            { name: 'No Loc', maneuver: { type: 'turn', modifier: 'right' } }, // no location → dropped
            { name: 'End St', maneuver: { type: 'arrive', modifier: '', location: [24.90, 60.30] } },
        ];
        const out = enc.osrmStepsToCoursePoints(coords, steps);
        expect(out).toEqual([{ index: 1, type: CP.LEFT, name: 'Main Rd' }]);
    });

    test('truncates the course-point name to 15 chars', () => {
        const steps = [
            { name: 'A very long street name indeed', maneuver: { type: 'turn', modifier: 'right', location: [24.90, 60.20] } },
        ];
        const out = enc.osrmStepsToCoursePoints(coords, steps);
        expect(out[0].name).toBe('A very long str'); // 15 chars
        expect(out[0].name.length).toBe(15);
    });
});

// ── encodeCourse (structure, header, CRCs, record count, positions) ──────────

describe('encodeCourse', () => {
    const coords = [[60.1699, 24.9384], [60.1750, 24.9500]];

    test('throws without at least 2 coordinates', () => {
        expect(() => enc.encodeCourse({ coords: [] })).toThrow();
        expect(() => enc.encodeCourse({ coords: [[60, 24]] })).toThrow();
        expect(() => enc.encodeCourse({})).toThrow();
    });

    test('14-byte header with profile version 2140 and ".FIT" magic', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        expect(out[0]).toBe(14);                  // header size
        expect(out[1]).toBe(0x10);                // protocol version
        expect(readU16LE([out[2], out[3]])).toBe(2140); // profile version
        expect([out[8], out[9], out[10], out[11]]).toEqual([0x2E, 0x46, 0x49, 0x54]); // ".FIT"
    });

    test('declared data size matches the body length', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        const { dataSize } = parseFit(out);
        // total = 14 (header) + dataSize + 2 (file CRC)
        expect(dataSize).toBe(out.length - 16);
    });

    test('header CRC and file CRC validate against an independent CRC', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        const { headerCrc, fileCrc } = parseFit(out);
        expect(headerCrc).toBe(crc16arc_ref(Array.from(out.slice(0, 12))));
        expect(fileCrc).toBe(crc16arc_ref(Array.from(out.slice(0, out.length - 2))));
    });

    test('emits one record per coordinate, plus the expected message set', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        const { messages } = parseFit(out);
        const count = (g) => messages.filter((m) => m.globalMesg === g).length;
        expect(count(G.RECORD)).toBe(coords.length); // one record per coord
        expect(count(G.FILE_ID)).toBe(1);
        expect(count(G.COURSE)).toBe(1);
        expect(count(G.LAP)).toBe(1);
        expect(count(G.EVENT)).toBe(2);              // start + stop
        expect(count(G.COURSE_POINT)).toBe(0);       // none supplied
    });

    test('record positions are semicircle-encoded coordinates', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        const recs = parseFit(out).messages.filter((m) => m.globalMesg === G.RECORD);
        for (let i = 0; i < coords.length; i++) {
            expect(readI32LE(recs[i].fields[0])).toBe(internals.toSemicircles(coords[i][0]));
            expect(readI32LE(recs[i].fields[1])).toBe(internals.toSemicircles(coords[i][1]));
        }
    });

    test('first record distance is 0; last equals cumulative haversine (cm)', () => {
        const out = enc.encodeCourse({ name: 'Test', coords });
        const recs = parseFit(out).messages.filter((m) => m.globalMesg === G.RECORD);
        expect(readU32LE(recs[0].fields[5])).toBe(0);
        const expectedCm = Math.round(
            internals.haversine(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) * 100
        );
        expect(readU32LE(recs[1].fields[5])).toBe(expectedCm);
    });

    test('emits one course_point per supplied turn cue', () => {
        const coursePoints = [{ index: 1, type: CP.LEFT, name: 'Turn' }];
        const out = enc.encodeCourse({ name: 'Test', coords, coursePoints });
        const { messages } = parseFit(out);
        const cps = messages.filter((m) => m.globalMesg === G.COURSE_POINT);
        expect(cps.length).toBe(1);
        expect(cps[0].fields[5][0]).toBe(CP.LEFT); // course_point.type (ENUM)
    });
});

// ── elevation offset encoding: (m + 500) * 5, clamped to [0, 65535] ──────────

describe('elevation encoding', () => {
    const coords = [[60.1699, 24.9384], [60.1750, 24.9500]];

    // Decode the altitude (field 2, UINT16) from each RECORD message.
    const altitudes = (elevations) => {
        const out = enc.encodeCourse({ name: 'Elev', coords, elevations });
        return parseFit(out).messages
            .filter((m) => m.globalMesg === G.RECORD)
            .map((m) => readU16LE(m.fields[2]));
    };

    test('nominal: altitude = (m + 500) * 5', () => {
        expect(altitudes([0, 100])).toEqual([2500, 3000]);
    });

    test('clamps at the low end to 0', () => {
        // m = -1000 → (-500)*5 = -2500 → clamp 0;  m = -500 → exactly 0
        expect(altitudes([-1000, -500])).toEqual([0, 0]);
    });

    test('clamps at the high end to 65535', () => {
        // m = 13000 → 67500 → clamp 65535;  m = 12607 → exactly 65535
        expect(altitudes([13000, 12607])).toEqual([65535, 65535]);
    });

    test('null elevation entry encodes as 0 m → 2500', () => {
        expect(altitudes([null, 0])).toEqual([2500, 2500]);
    });
});
