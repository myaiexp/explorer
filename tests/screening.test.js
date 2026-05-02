/**
 * Tests for screening.js — water-aware reachability filtering.
 *
 * Loading: screening.js depends on haversineM from loop-quality.js. Both are
 * non-module browser scripts loaded into the current realm via Node's vm
 * module; explicit globalThis assignments expose the helpers.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const LOOP_QUALITY_SRC = readFileSync(resolve(__dirname, '../loop-quality.js'), 'utf8');
const SCREENING_SRC    = readFileSync(resolve(__dirname, '../screening.js'),    'utf8');

beforeAll(() => {
    new vm.Script(LOOP_QUALITY_SRC).runInThisContext();  // exposes haversineM
    new vm.Script(SCREENING_SRC).runInThisContext();
});

// ── passesStage1 ────────────────────────────────────────────────────────────

test('passesStage1: null nearestResult → false', () => {
    expect(globalThis.passesStage1({lat:60.17,lng:24.94}, null)).toBe(false);
});

test('passesStage1: snap within threshold → true', () => {
    // ~100 m offset, well under 500 m
    const c = {lat:60.17, lng:24.94};
    const n = {lat:60.1709, lng:24.94};
    expect(globalThis.passesStage1(c, n)).toBe(true);
});

test('passesStage1: snap exceeds threshold → false', () => {
    // ~1.1 km offset, over 500 m
    const c = {lat:60.17, lng:24.94};
    const n = {lat:60.18, lng:24.94};
    expect(globalThis.passesStage1(c, n)).toBe(false);
});

// ── detourRatio ────────────────────────────────────────────────────────────

test('detourRatio: identical km → 1.0', () => {
    // 5 km route, 5 km straight
    expect(globalThis.detourRatio(5000, 5)).toBeCloseTo(1.0, 5);
});

test('detourRatio: null route → Infinity', () => {
    expect(globalThis.detourRatio(null, 5)).toBe(Infinity);
});

test('detourRatio: zero straight → Infinity', () => {
    expect(globalThis.detourRatio(5000, 0)).toBe(Infinity);
});

test('detourRatio: 3× route → 3.0', () => {
    expect(globalThis.detourRatio(15000, 5)).toBeCloseTo(3.0, 5);
});

// ── screenCandidates ────────────────────────────────────────────────────────

const START = {lat:60.17, lng:24.94};
// Three candidates ~5 km away, far enough that detour math is meaningful.
const CANDS = [
    {lat:60.215, lng:24.94},  // c0
    {lat:60.215, lng:25.00},  // c1
    {lat:60.215, lng:25.06},  // c2
];

test('screenCandidates: all pass → all survivors, null bestRejected', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});  // ~11 m snap
    const routeFn   = async (s,c) => ({distance: 6000});  // ~6 km route, ~5 km straight → 1.2
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(3);
    expect(r.bestRejected).toBeNull();
    expect(r.survivors[0].snapM).toBeLessThan(20);
    expect(r.survivors[0].detour).toBeCloseTo(1.2, 1);
});

test('screenCandidates: all stage-1 fail → empty survivors, bestRejected by min snapM', async () => {
    // Three candidates with progressively larger snap distances, all > 500 m.
    const offsets = [0.01, 0.02, 0.005];  // ~1.1 km, 2.2 km, 0.55 km
    let i = 0;
    const nearestFn = async (c) => ({lat:c.lat + offsets[i++], lng:c.lng});
    const routeFn   = async () => { throw new Error('stage 2 should not be called'); };
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    // c2 had the smallest snap (~550 m), so it's bestRejected
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[2].lat, lng: CANDS[2].lng}));
    expect(r.bestRejected.snapM).toBeGreaterThan(500);
});

test('screenCandidates: stage 1 passes but stage 2 rejects → bestRejected by min detour', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    // straight distances differ: c0 ~5 km, c1 ~6 km, c2 ~8.3 km. Routes give
    // detours c0=6.0×, c1=3.3×, c2=6.0× — all > 2.2 → all stage-2 rejected.
    const routes = [{distance:30000}, {distance:20000}, {distance:50000}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[1].lat, lng: CANDS[1].lng}));
    expect(r.bestRejected.detour).toBeCloseTo(3.3, 1);
});

test('screenCandidates: mixed → only survivors annotated', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    // c0 passes (1.2×), c1 rejected (5×), c2 passes (1.5×)
    const routes = [{distance:6000}, {distance:25000}, {distance:7500}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors).toEqual([
        expect.objectContaining({lat: CANDS[0].lat, lng: CANDS[0].lng}),
        expect.objectContaining({lat: CANDS[2].lat, lng: CANDS[2].lng}),
    ]);
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[1].lat, lng: CANDS[1].lng}));
});

test('screenCandidates: nearestFn returns null for one → that one rejected, others screen', async () => {
    let call = 0;
    const nearestFn = async (c) => {
        call++;
        return call === 2 ? null : {lat:c.lat+0.0001, lng:c.lng};
    };
    const routeFn = async () => ({distance: 6000});
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors.find(s => s === CANDS[1])).toBeUndefined();
});

test('screenCandidates: routeFn returns null for one → that one rejected at stage 2', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    let call = 0;
    const routeFn = async () => (++call === 2 ? null : {distance: 6000});
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
});

test('screenCandidates: empty candidates → empty survivors, null bestRejected', async () => {
    const nearestFn = async () => { throw new Error('should not be called'); };
    const routeFn   = async () => { throw new Error('should not be called'); };
    const r = await globalThis.screenCandidates(START, [], {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toBeNull();
    expect(r.diagnostics).toHaveLength(0);
});

test('screenCandidates: diagnostics array length equals input count, with stage labels', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    const routes = [{distance:6000}, {distance:25000}, {distance:7500}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.diagnostics).toHaveLength(3);
    expect(r.diagnostics.map(d => d.stage)).toEqual(['survived', 'stage2-reject', 'survived']);
});

test('screenCandidates: input candidate objects are not mutated', async () => {
    const original = JSON.parse(JSON.stringify(CANDS));
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    const routeFn   = async () => ({distance: 6000});
    await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(CANDS).toEqual(original);
});

// ── capPool ────────────────────────────────────────────────────────────────

test('capPool: array below cap returned unchanged (same identity)', () => {
    const small = Array.from({length: 10}, (_, i) => ({lat: 60 + i*0.001, lng: 24}));
    expect(globalThis.capPool(small)).toBe(small);
});

test('capPool: array exactly at cap returned unchanged', () => {
    const exact = Array.from({length: globalThis.SCREENING_POOL_CAP}, (_, i) => ({lat: 60, lng: 24 + i*0.001}));
    expect(globalThis.capPool(exact)).toBe(exact);
});

test('capPool: array above cap returns new array of length cap', () => {
    const big = Array.from({length: 200}, (_, i) => ({lat: 60, lng: 24 + i*0.001, idx: i}));
    const r = globalThis.capPool(big);
    expect(r).not.toBe(big);
    expect(r).toHaveLength(globalThis.SCREENING_POOL_CAP);
    expect(big).toHaveLength(200);  // input untouched
});

test('capPool: down-sample preserves candidate identity (no clones)', () => {
    const big = Array.from({length: 100}, (_, i) => ({lat: 60, lng: 24 + i*0.001, idx: i}));
    const r = globalThis.capPool(big);
    for (const c of r) expect(big).toContain(c);
});

test('capPool: down-sample is randomized (not just first-N)', () => {
    // With 200 input and cap 45, P(every sample is first-45) is astronomically
    // low (≈ (45/200)^45). Across 5 runs we should see at least one idx ≥ 45.
    const big = Array.from({length: 200}, (_, i) => ({lat: 60, lng: 24 + i*0.001, idx: i}));
    let sawHigh = false;
    for (let i = 0; i < 5; i++) {
        const r = globalThis.capPool(big);
        if (r.some(c => c.idx >= 45)) { sawHigh = true; break; }
    }
    expect(sawHigh).toBe(true);
});

test('capPool: handles null/empty', () => {
    expect(globalThis.capPool(null)).toBe(null);
    expect(globalThis.capPool([])).toEqual([]);
});

test('screenCandidates: bestRejected does not mutate input candidate', async () => {
    const cands = [{lat:60.215, lng:24.94}];
    const original = JSON.parse(JSON.stringify(cands));
    // Stage-1 reject: snap > 500 m.
    const nearestFn = async (c) => ({lat:c.lat+0.01, lng:c.lng});
    const routeFn   = async () => { throw new Error('stage 2 should not be called'); };
    const r = await globalThis.screenCandidates(START, cands, {nearestFn, routeFn});
    expect(r.bestRejected.snapM).toBeGreaterThan(500);
    expect(cands).toEqual(original);  // input untouched
    expect(cands[0]).not.toHaveProperty('snapM');
});
