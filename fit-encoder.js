// Garmin FIT course-file encoder — emits binary .fit for watch import.
// Implements the minimum FIT protocol subset needed for Garmin Connect to
// recognise a navigable course: file_id, file_creator, course, lap,
// event(start/stop), record (per coord), course_point (per turn cue).
// Spec reference: https://developer.garmin.com/fit/protocol/

(function (global) {
    'use strict';

    const FIT_EPOCH = 631065600;              // 1989-12-31 00:00:00 UTC, Unix s
    const SEMICIRCLE = Math.pow(2, 31) / 180;
    const WALK_MPS = 1.39;                    // 5 km/h, for synthetic timestamps

    // FIT base type descriptors. id is the on-wire byte; size is per-element width.
    const T = {
        ENUM:    { id: 0x00, size: 1 }, UINT8:   { id: 0x02, size: 1 },
        UINT16:  { id: 0x84, size: 2 }, UINT32:  { id: 0x86, size: 4 },
        SINT32:  { id: 0x85, size: 4 }, UINT32Z: { id: 0x8C, size: 4 },
        STRING:  { id: 0x07 }
    };
    const M = { FILE_ID: 0, FILE_CREATOR: 49, COURSE: 31, LAP: 19, EVENT: 21, RECORD: 20, COURSE_POINT: 32 };
    const CP = {
        GENERIC: 0, SUMMIT: 1, LEFT: 6, RIGHT: 7, STRAIGHT: 8,
        LEFT_FORK: 16, RIGHT_FORK: 17, MIDDLE_FORK: 18,
        SLIGHT_LEFT: 19, SHARP_LEFT: 20, SLIGHT_RIGHT: 21, SHARP_RIGHT: 22,
        U_TURN: 23
    };

    // ── ByteWriter: growable little-endian byte buffer ───────────────────────
    function ByteWriter() {
        const bytes = [];
        const enc = new TextEncoder();
        return {
            u8(v)  { bytes.push(v & 0xFF); },
            u16(v) { bytes.push(v & 0xFF, (v >> 8) & 0xFF); },
            u32(v) { bytes.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF); },
            i32(v) {
                const u = v < 0 ? v + 0x100000000 : v;
                bytes.push(u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF, (u >>> 24) & 0xFF);
            },
            string(s, fieldSize) {
                const buf = enc.encode(s).slice(0, fieldSize - 1); // leave room for null
                for (const b of buf) bytes.push(b);
                for (let i = buf.length; i < fieldSize; i++) bytes.push(0);
            },
            length() { return bytes.length; },
            toUint8Array() { return new Uint8Array(bytes); }
        };
    }

    // ── FIT CRC-16 (4-bit table variant) ─────────────────────────────────────
    const CRC_TABLE = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400
    ];

    function crc16(buffer) {
        let crc = 0;
        for (let i = 0; i < buffer.length; i++) {
            const byte = buffer[i];
            let tmp = CRC_TABLE[crc & 0xF];
            crc = (crc >>> 4) & 0x0FFF;
            crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF];

            tmp = CRC_TABLE[crc & 0xF];
            crc = (crc >>> 4) & 0x0FFF;
            crc = crc ^ tmp ^ CRC_TABLE[(byte >>> 4) & 0xF];
        }
        return crc & 0xFFFF;
    }

    // Definition message: declares field layout for subsequent data messages
    // sharing the same localType. Field tuple: [defNum, baseType, sizeOverride?].
    function writeDefinition(w, localType, globalMesg, fields) {
        w.u8(0x40 | (localType & 0x0F));
        w.u8(0x00);          // reserved
        w.u8(0x00);          // architecture: little endian
        w.u16(globalMesg);
        w.u8(fields.length);
        for (const [defNum, baseType, sizeOverride] of fields) {
            const size = baseType.id === T.STRING.id ? sizeOverride : baseType.size;
            w.u8(defNum); w.u8(size); w.u8(baseType.id);
        }
    }

    // Haversine distance in meters
    function haversine(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    function toSemicircles(deg) { return Math.round(deg * SEMICIRCLE); }
    function toFitTime(unix)    { return Math.max(0, Math.round(unix - FIT_EPOCH)); }

    // input: { name, coords: [[lat, lng], ...], coursePoints?: [{ index, type, name }], elevations?: [m, ...] }
    function encodeCourse(input) {
        const name = (input.name || 'Wander route').slice(0, 15);
        const coords = input.coords;
        if (!coords || coords.length < 2) throw new Error('encodeCourse: need >=2 coordinates');
        const elevations = input.elevations || null;
        const coursePoints = input.coursePoints || [];

        // Cumulative distance per coord
        const cumDist = new Float64Array(coords.length);
        for (let i = 1; i < coords.length; i++) {
            cumDist[i] = cumDist[i - 1] + haversine(
                coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]
            );
        }
        const totalDist = cumDist[coords.length - 1];
        const totalElapsed = Math.round(totalDist / WALK_MPS);

        const startUnix = Math.floor(Date.now() / 1000);
        const startFit = toFitTime(startUnix);
        const endFit   = toFitTime(startUnix + totalElapsed);

        const w = ByteWriter();

        // file_id
        writeDefinition(w, 0, M.FILE_ID, [
            [3, T.UINT32Z], [4, T.UINT32], [1, T.UINT16], [2, T.UINT16], [0, T.ENUM]
        ]);
        w.u8(0x00);
        w.u32(0x12345678);   // serial_number
        w.u32(startFit);     // time_created
        w.u16(255);          // manufacturer = development
        w.u16(0);            // product
        w.u8(6);             // type = course

        // file_creator
        writeDefinition(w, 1, M.FILE_CREATOR, [[0, T.UINT16], [1, T.UINT8]]);
        w.u8(0x01);
        w.u16(100);          // sw 1.00
        w.u8(0);             // hw

        // course
        const NAME_SIZE = 16;
        writeDefinition(w, 2, M.COURSE, [[5, T.STRING, NAME_SIZE], [4, T.ENUM]]);
        w.u8(0x02);
        w.string(name, NAME_SIZE);
        w.u8(11);            // sport = walking

        // lap (summary)
        writeDefinition(w, 3, M.LAP, [
            [253, T.UINT32], [2, T.UINT32],
            [3, T.SINT32], [4, T.SINT32], [5, T.SINT32], [6, T.SINT32],
            [7, T.UINT32], [8, T.UINT32], [9, T.UINT32], [25, T.ENUM]
        ]);
        w.u8(0x03);
        w.u32(endFit);                                       // timestamp
        w.u32(startFit);                                     // start_time
        w.i32(toSemicircles(coords[0][0]));                  // start_position_lat
        w.i32(toSemicircles(coords[0][1]));                  // start_position_long
        w.i32(toSemicircles(coords[coords.length - 1][0]));  // end_position_lat
        w.i32(toSemicircles(coords[coords.length - 1][1]));  // end_position_long
        w.u32(totalElapsed * 1000);                          // total_elapsed_time
        w.u32(totalElapsed * 1000);                          // total_timer_time
        w.u32(Math.round(totalDist * 100));                  // total_distance (cm)
        w.u8(11);                                            // sport = walking

        // event start/stop share one definition
        writeDefinition(w, 4, M.EVENT, [[253, T.UINT32], [0, T.ENUM], [1, T.ENUM]]);
        w.u8(0x04);
        w.u32(startFit);
        w.u8(0);             // event = timer
        w.u8(0);             // event_type = start

        // records
        const recFields = elevations
            ? [[253, T.UINT32], [0, T.SINT32], [1, T.SINT32], [5, T.UINT32], [2, T.UINT16]]
            : [[253, T.UINT32], [0, T.SINT32], [1, T.SINT32], [5, T.UINT32]];
        writeDefinition(w, 5, M.RECORD, recFields);

        for (let i = 0; i < coords.length; i++) {
            w.u8(0x05);
            w.u32(startFit + Math.round(cumDist[i] / WALK_MPS));
            w.i32(toSemicircles(coords[i][0]));
            w.i32(toSemicircles(coords[i][1]));
            w.u32(Math.round(cumDist[i] * 100));
            if (elevations) {
                const m = elevations[i] != null ? elevations[i] : 0;
                w.u16(Math.max(0, Math.min(0xFFFF, Math.round((m + 500) * 5))));
            }
        }

        // course_point definition + data
        if (coursePoints.length > 0) {
            const CP_NAME = 16;
            writeDefinition(w, 6, M.COURSE_POINT, [
                [1, T.UINT32], [2, T.SINT32], [3, T.SINT32],
                [4, T.UINT32], [5, T.ENUM], [6, T.STRING, CP_NAME]
            ]);
            for (const cp of coursePoints) {
                const idx = Math.max(0, Math.min(coords.length - 1, cp.index));
                w.u8(0x06);
                w.u32(startFit + Math.round(cumDist[idx] / WALK_MPS));
                w.i32(toSemicircles(coords[idx][0]));
                w.i32(toSemicircles(coords[idx][1]));
                w.u32(Math.round(cumDist[idx] * 100));
                w.u8(cp.type);
                w.string(cp.name || '', CP_NAME);
            }
        }

        // event stop
        w.u8(0x04);
        w.u32(endFit);
        w.u8(0);             // event = timer
        w.u8(4);             // event_type = stop_all

        // ── Header (14 bytes including its own CRC) ─────────────────────────
        const records = w.toUint8Array();
        const dataSize = records.length;
        const headerNoCrc = new Uint8Array([
            14, 0x10,
            0x5C, 0x08,                                   // profile_version 2140 LE
            dataSize & 0xFF, (dataSize >> 8) & 0xFF,
            (dataSize >> 16) & 0xFF, (dataSize >>> 24) & 0xFF,
            0x2E, 0x46, 0x49, 0x54                        // ".FIT"
        ]);
        const headerCrc = crc16(headerNoCrc);
        const header = new Uint8Array(14);
        header.set(headerNoCrc, 0);
        header[12] = headerCrc & 0xFF;
        header[13] = (headerCrc >> 8) & 0xFF;

        // ── File CRC over header + records ──────────────────────────────────
        const all = new Uint8Array(header.length + records.length);
        all.set(header, 0);
        all.set(records, header.length);
        const fileCrc = crc16(all);

        const out = new Uint8Array(all.length + 2);
        out.set(all, 0);
        out[all.length] = fileCrc & 0xFF;
        out[all.length + 1] = (fileCrc >> 8) & 0xFF;
        return out;
    }

    // ── OSRM step → course_point mapping ─────────────────────────────────────
    function osrmStepToType(step) {
        if (!step || !step.maneuver) return CP.GENERIC;
        const { type = '', modifier = '' } = step.maneuver;
        if (type === 'depart' || type === 'arrive') return null;
        if (type === 'fork') {
            if (modifier.includes('right')) return CP.RIGHT_FORK;
            if (modifier.includes('left'))  return CP.LEFT_FORK;
            return CP.MIDDLE_FORK;
        }
        switch (modifier) {
            case 'uturn':         return CP.U_TURN;
            case 'sharp right':   return CP.SHARP_RIGHT;
            case 'right':         return CP.RIGHT;
            case 'slight right':  return CP.SLIGHT_RIGHT;
            case 'straight':      return CP.STRAIGHT;
            case 'slight left':   return CP.SLIGHT_LEFT;
            case 'left':          return CP.LEFT;
            case 'sharp left':    return CP.SHARP_LEFT;
            default:              return CP.GENERIC;
        }
    }

    function nearestCoordIndex(coords, lat, lng) {
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < coords.length; i++) {
            const d = haversine(coords[i][0], coords[i][1], lat, lng);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    function osrmStepsToCoursePoints(coords, steps) {
        if (!steps || !steps.length) return [];
        const out = [];
        for (const step of steps) {
            const type = osrmStepToType(step);
            if (type === null) continue;
            const loc = step.maneuver && step.maneuver.location;
            if (!loc) continue;
            const [lng, lat] = loc;
            const idx = nearestCoordIndex(coords, lat, lng);
            const name = (step.name || '').slice(0, 15);
            out.push({ index: idx, type, name });
        }
        return out;
    }

    global.FitEncoder = { encodeCourse, osrmStepsToCoursePoints, CP };
})(typeof window !== 'undefined' ? window : globalThis);
