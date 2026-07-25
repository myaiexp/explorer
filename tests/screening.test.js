// @vitest-environment node
/**
 * Tests for screening.js — water-aware reachability filtering.
 *
 * Loading: screening.js depends on the canonical globalThis.haversineM from
 * geo-utils.js (audit #1262 — it no longer relies on loop-quality.js's old
 * implicit global) and on novelty.js's partialShuffle. Those edges live in
 * helpers/load.js's SCRIPT_DEPS, so loading 'screening' pulls them in order.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('screening');
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

test('detourRatio: zero route metres → Infinity (degenerate start==dest)', () => {
    // 0-metre route means start == destination; !routeMeters is truthy for 0,
    // so it returns the Infinity sentinel rather than dividing.
    expect(globalThis.detourRatio(0, 1.0)).toBe(Infinity);
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
    const tableFn = async () => [
        {snapM: 11, routeM: 6000},
        {snapM: 11, routeM: 6000},
        {snapM: 11, routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(3);
    expect(r.bestRejected).toBeNull();
    expect(r.survivors[0].snapM).toBe(11);
    expect(r.survivors[0].detour).toBeCloseTo(1.2, 1);
});

test('screenCandidates: all stage-1 fail → empty survivors, bestRejected by min snapM', async () => {
    // Three candidates with progressively larger snap distances, all > 500 m.
    const tableFn = async () => [
        {snapM: 1100, routeM: null},
        {snapM: 2200, routeM: null},
        {snapM:  550, routeM: null},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(0);
    // c2 had the smallest snap (550 m), so it's bestRejected
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[2].lat, lng: CANDS[2].lng}));
    expect(r.bestRejected.snapM).toBe(550);
});

test('screenCandidates: stage 1 passes but stage 2 rejects → bestRejected by min detour', async () => {
    // straight distances: c0 ~5 km, c1 ~6 km, c2 ~8.3 km. Routes give detours
    // c0=6.0×, c1=3.3×, c2=6.0× — all > 2.2 → all stage-2 rejected.
    const tableFn = async () => [
        {snapM: 11, routeM: 30000},
        {snapM: 11, routeM: 20000},
        {snapM: 11, routeM: 50000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[1].lat, lng: CANDS[1].lng}));
    expect(r.bestRejected.detour).toBeCloseTo(3.3, 1);
});

test('screenCandidates: mixed → only survivors annotated', async () => {
    // c0 passes (1.2×), c1 rejected (5×), c2 passes (1.5×)
    const tableFn = async () => [
        {snapM: 11, routeM:  6000},
        {snapM: 11, routeM: 25000},
        {snapM: 11, routeM:  7500},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors).toEqual([
        expect.objectContaining({lat: CANDS[0].lat, lng: CANDS[0].lng}),
        expect.objectContaining({lat: CANDS[2].lat, lng: CANDS[2].lng}),
    ]);
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[1].lat, lng: CANDS[1].lng}));
});

test('screenCandidates: snapM null for one → that one rejected, others screen', async () => {
    const tableFn = async () => [
        {snapM:   11, routeM: 6000},
        {snapM: null, routeM: null},
        {snapM:   11, routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors.find(s => s.lat === CANDS[1].lat && s.lng === CANDS[1].lng)).toBeUndefined();
});

test('screenCandidates: routeM null for one → that one rejected at stage 2', async () => {
    const tableFn = async () => [
        {snapM: 11, routeM: 6000},
        {snapM: 11, routeM: null},
        {snapM: 11, routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
});

test('screenCandidates: empty candidates → empty survivors, null bestRejected', async () => {
    const tableFn = async () => { throw new Error('should not be called'); };
    const r = await globalThis.screenCandidates(START, [], {tableFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toBeNull();
    expect(r.diagnostics).toHaveLength(0);
});

test('screenCandidates: diagnostics array length equals input count, with stage labels', async () => {
    const tableFn = async () => [
        {snapM: 11, routeM:  6000},
        {snapM: 11, routeM: 25000},
        {snapM: 11, routeM:  7500},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.diagnostics).toHaveLength(3);
    expect(r.diagnostics.map(d => d.stage)).toEqual(['survived', 'stage2-reject', 'survived']);
});

test('screenCandidates: input candidate objects are not mutated', async () => {
    const original = JSON.parse(JSON.stringify(CANDS));
    const tableFn = async () => CANDS.map(() => ({snapM: 11, routeM: 6000}));
    await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(CANDS).toEqual(original);
});

test('screenCandidates: all rejects nearest-failed (null snapM) → bestRejected null', async () => {
    // Every candidate fails Stage 1 with snapM null, so no reject has a snapM
    // or a detour. The bestRejected scan finds nothing to pick → stays null.
    const tableFn = async () => [
        {snapM: null, routeM: null},
        {snapM: null, routeM: null},
        {snapM: null, routeM: null},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toBeNull();
    expect(r.diagnostics.every(d => d.reason === 'nearest-failed')).toBe(true);
});

test('screenCandidates: literal null table entry → nearest-failed (table[i] ?? {})', async () => {
    // A literal null row (not {} or {snapM:null}) exercises the ?? {} fallback.
    const tableFn = async () => [
        {snapM: 11, routeM: 6000},
        null,
        {snapM: 11, routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
    const d = r.diagnostics[1];
    expect(d.stage).toBe('stage1-reject');
    expect(d.reason).toBe('nearest-failed');
    expect(d.snapM).toBeNull();
});

test('screenCandidates: snapM Infinity → nearest-failed (isFinite guard)', async () => {
    // OSRM can return Infinity for an unreachable node; isFinite() coerces it
    // to null so the candidate is classified as nearest-failed, not snap-too-far.
    const tableFn = async () => [
        {snapM: 11,       routeM: 6000},
        {snapM: Infinity, routeM: null},
        {snapM: 11,       routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
    const d = r.diagnostics[1];
    expect(d.stage).toBe('stage1-reject');
    expect(d.reason).toBe('nearest-failed');
    expect(d.snapM).toBeNull();
});

test('screenCandidates: stage-2 reject preferred over stage-1 rejects for bestRejected', async () => {
    // c0 snap-too-far (stage-1, detour null), c1 detour-too-high (stage-2,
    // detour ~3.3×), c2 nearest-failed (stage-1, detour null). The lone
    // detour-bearing reject must win over both snap-only rejects.
    const tableFn = async () => [
        {snapM: 600,  routeM: null},   // stage-1 reject: snap > 500 m
        {snapM: 11,   routeM: 20000},  // stage-2 reject: detour ~3.3×
        {snapM: null, routeM: null},   // stage-1 reject: nearest-failed
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toEqual(expect.objectContaining({lat: CANDS[1].lat, lng: CANDS[1].lng}));
    expect(r.bestRejected.detour).toBeCloseTo(3.3, 1);
});

test('screenCandidates: routeM 0 (start==dest) → rejected at stage 2 with null detour', async () => {
    // detourRatio(0, straightKm) returns Infinity → coerced to null detour →
    // classified detour-too-high (stage-2 reject), never a survivor.
    const tableFn = async () => [
        {snapM: 11, routeM: 0},
        {snapM: 11, routeM: 6000},
        {snapM: 11, routeM: 6000},
    ];
    const r = await globalThis.screenCandidates(START, CANDS, {tableFn});
    expect(r.survivors).toHaveLength(2);
    const d = r.diagnostics[0];
    expect(d.stage).toBe('stage2-reject');
    expect(d.reason).toBe('detour-too-high');
    expect(d.detour).toBeNull();
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
    const tableFn = async () => [{snapM: 1100, routeM: null}];
    const r = await globalThis.screenCandidates(START, cands, {tableFn});
    expect(r.bestRejected.snapM).toBe(1100);
    expect(cands).toEqual(original);  // input untouched
    expect(cands[0]).not.toHaveProperty('snapM');
});

test('screenCandidates: tableFn throw propagates to caller', async () => {
    const tableFn = async () => { throw new Error('osrm down'); };
    await expect(globalThis.screenCandidates(START, CANDS, {tableFn})).rejects.toThrow('osrm down');
});

test('screenCandidates: malformed table response throws', async () => {
    const tableFn = async () => [{snapM: 11, routeM: 6000}];  // length mismatch
    await expect(globalThis.screenCandidates(START, CANDS, {tableFn})).rejects.toThrow(/malformed/);
});
