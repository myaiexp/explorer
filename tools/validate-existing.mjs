// Validate an existing .fit file with @garmin/fitsdk.
// Usage: node validate-existing.mjs <path>
import { readFileSync } from 'node:fs';
import { Decoder, Stream } from '@garmin/fitsdk';

const path = process.argv[2];
if (!path) { console.error('usage: validate-existing.mjs <path>'); process.exit(1); }
const bytes = readFileSync(path);
const stream = Stream.fromByteArray(bytes);
const decoder = new Decoder(stream);
console.log(`isFIT: ${decoder.isFIT()}  checkIntegrity: ${decoder.checkIntegrity()}`);
const { messages, errors } = decoder.read({ applyScaleAndOffset: true, convertTypesToStrings: true, convertDateTimesToDates: false });
if (errors.length) { console.error('errors:', errors); process.exit(2); }
const summary = {};
for (const [k, v] of Object.entries(messages)) summary[k] = Array.isArray(v) ? v.length : 1;
console.log('messages:', summary);
console.log('file_id.type:', messages.fileIdMesgs?.[0]?.type);
console.log('course.name:', messages.courseMesgs?.[0]?.name, 'sport:', messages.courseMesgs?.[0]?.sport);
console.log('lap.totalDistance(m):', messages.lapMesgs?.[0]?.totalDistance);
console.log('records:', messages.recordMesgs?.length);
console.log('first record:', messages.recordMesgs?.[0]);
console.log('last record:', messages.recordMesgs?.[messages.recordMesgs.length - 1]);
const cps = messages.coursePointMesgs || [];
console.log(`course_points: ${cps.length}`);
for (const cp of cps) console.log('  ', cp.type, '|', cp.name, '@', cp.positionLat, cp.positionLong);
console.log('OK');
