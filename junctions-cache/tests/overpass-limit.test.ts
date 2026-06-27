// @vitest-environment node
// Tests for junctions-cache/src/overpass-limit.ts — the global concurrency cap
// + bounded wait queue that fronts every outbound Overpass fetch (audit:
// /junctions could trigger unbounded parallel Overpass queries with distinct
// bboxes). The module holds singleton state (active count + waiter queue), so
// each test re-imports it fresh via vi.resetModules().

import { describe, test, expect, vi, beforeEach } from 'vitest';

type Limit = typeof import('../src/overpass-limit.js');
let mod: Limit;

beforeEach(async () => {
    vi.resetModules();
    mod = await import('../src/overpass-limit.js');
});

// A promise plus its resolve/reject, so a test can hold a "fetch" open and
// release it on demand to drive the slot/queue transitions deterministically.
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Drain the microtask + macrotask queue so all pending continuations settle.
const flush = () => new Promise(r => setTimeout(r, 0));

describe('runWithOverpassSlot', () => {
    test('returns the wrapped fn result and releases the slot afterwards', async () => {
        const r = await mod.runWithOverpassSlot(() => Promise.resolve('done'));
        expect(r).toBe('done');
        expect(mod.overpassInFlight()).toBe(0);
        expect(mod.overpassQueued()).toBe(0);
    });

    test('caps concurrency at 2 — a third call waits until a slot frees', async () => {
        const d1 = deferred<string>();
        const d2 = deferred<string>();
        const d3 = deferred<string>();

        const p1 = mod.runWithOverpassSlot(() => d1.promise);
        const p2 = mod.runWithOverpassSlot(() => d2.promise);
        const p3 = mod.runWithOverpassSlot(() => d3.promise);

        // Two slots are busy; the third is parked in the queue, not running.
        expect(mod.overpassInFlight()).toBe(2);
        expect(mod.overpassQueued()).toBe(1);

        // Freeing one slot promotes the queued call into it.
        d1.resolve('a');
        await p1;
        await flush();
        expect(mod.overpassInFlight()).toBe(2);
        expect(mod.overpassQueued()).toBe(0);

        d2.resolve('b');
        d3.resolve('c');
        expect(await Promise.all([p2, p3])).toEqual(['b', 'c']);
        expect(mod.overpassInFlight()).toBe(0);
    });

    test('a failing fn still releases its slot and wakes the next waiter', async () => {
        await expect(
            mod.runWithOverpassSlot(() => Promise.reject(new Error('boom')))
        ).rejects.toThrow('boom');
        expect(mod.overpassInFlight()).toBe(0);

        // The slot is reusable — a subsequent call is not wedged shut.
        await expect(
            mod.runWithOverpassSlot(() => Promise.resolve('ok'))
        ).resolves.toBe('ok');
    });

    test('overflow past the wait-queue cap fails fast instead of growing unbounded', async () => {
        const held: Array<ReturnType<typeof deferred<string>>> = [];
        // Fill both slots (2) and the entire wait queue (MAX_QUEUED = 24) with
        // never-resolving fetches.
        for (let i = 0; i < 2 + 24; i++) {
            const d = deferred<string>();
            held.push(d);
            void mod.runWithOverpassSlot(() => d.promise);
        }
        expect(mod.overpassInFlight()).toBe(2);
        expect(mod.overpassQueued()).toBe(24);

        // The 27th caller can neither run nor queue → rejects immediately.
        await expect(
            mod.runWithOverpassSlot(() => Promise.resolve('x'))
        ).rejects.toThrow(/queue full/);

        // Release everything so no promise dangles into the next test's module.
        held.forEach((d, i) => d.resolve(String(i)));
        await flush();
    });
});
