// Round-trip validator: encode a synthetic course with our encoder,
// decode it with @garmin/fitsdk, and assert the structure round-trips cleanly.
// Run: npx --package=@garmin/fitsdk -- node tools/validate-fit.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { Decoder, Stream } from '@garmin/fitsdk';

// Load the browser-style encoder into the current realm (it self-registers on globalThis).
const src = readFileSync(new URL('../fit-encoder.js', import.meta.url), 'utf8');
new Script(src).runInThisContext();
const FE = globalThis.FitEncoder;
if (!FE) { console.error('FitEncoder did not register'); process.exit(1); }

// Synthetic course: 5 coords across central Helsinki, ~1 km
const coords = [
    [60.1700, 24.9300],
    [60.1710, 24.9320],
    [60.1720, 24.9340],
    [60.1715, 24.9370],
    [60.1700, 24.9380]
];
const elevations = [10, 15, 20, 12, 8];
const coursePoints = [
    { index: 1, type: FE.CP.RIGHT, name: 'Aleksanterinkatu' },
    { index: 3, type: FE.CP.LEFT,  name: 'Mannerheimintie' }
];

const bytes = FE.encodeCourse({ name: 'Validator route', coords, coursePoints, elevations });
console.log(`encoded ${bytes.length} bytes`);

writeFileSync(new URL('./out.fit', import.meta.url), bytes);

const stream = Stream.fromByteArray(bytes);
const decoder = new Decoder(stream);

const integrityOk = decoder.isFIT() && decoder.checkIntegrity();
console.log(`isFIT: ${decoder.isFIT()}  checkIntegrity: ${decoder.checkIntegrity()}`);
if (!integrityOk) {
    console.error('Integrity check FAILED');
    process.exit(2);
}

const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: false
});

if (errors.length) {
    console.error('Decoder errors:', errors);
    process.exit(3);
}

const summary = {};
for (const [k, v] of Object.entries(messages)) summary[k] = Array.isArray(v) ? v.length : 1;
console.log('messages:', summary);

const fileId = messages.fileIdMesgs?.[0];
console.log('file_id.type:', fileId?.type);

const course = messages.courseMesgs?.[0];
console.log('course.name:', course?.name, 'sport:', course?.sport);

const lap = messages.lapMesgs?.[0];
console.log('lap.totalDistance(m):', lap?.totalDistance,
            'start:', lap?.startPositionLat, lap?.startPositionLong,
            'end:', lap?.endPositionLat, lap?.endPositionLong);

const records = messages.recordMesgs || [];
console.log(`records: ${records.length}`);
console.log('first record:', records[0]);
console.log('last record:', records[records.length - 1]);

const cps = messages.coursePointMesgs || [];
console.log(`course_points: ${cps.length}`);
for (const cp of cps) console.log('  ', cp.type, cp.name, '@', cp.positionLat, cp.positionLong);

const ok =
    fileId?.type === 'course' &&
    course?.name?.startsWith('Validator route') &&
    records.length === coords.length &&
    cps.length === coursePoints.length;

if (!ok) { console.error('STRUCTURAL ASSERTIONS FAILED'); process.exit(4); }
console.log('OK');
