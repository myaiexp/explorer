// @vitest-environment jsdom
/**
 * Tests for storage.js — the array-backed read/write accessors. jsdom supplies
 * localStorage; storage.js is a non-module browser script, loaded via
 * helpers/load.js's loadScripts('storage'), exposing its helpers on globalThis.
 * Focus: the read/write round-trip symmetry that lets sync-helpers.js's
 * syncedPut/syncedDelete keep the persist-and-mirror invariant in one place.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('storage');
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

// A jsdom-friendly stand-in for the browser's QuotaExceededError.
function quotaError() {
    const e = new Error('quota exceeded');
    e.name = 'QuotaExceededError';
    return e;
}

// Build N visits, newest last by ISO date, each carrying full route geometry.
function visitsWithGeometry(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: 'v' + i,
        date: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        routeCoords: [[1, 2], [3, 4]],
        returnRouteCoords: [[5, 6]],
    }));
}

describe('writeStoredArray / readStoredArray', () => {
    test('round-trips an array through localStorage', () => {
        const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
        globalThis.writeStoredArray('k', rows);
        expect(localStorage.getItem('k')).toBe(JSON.stringify(rows));
        expect(globalThis.readStoredArray('k')).toEqual(rows);
    });

    test('writing an empty array reads back as empty (not the missing-key default)', () => {
        globalThis.writeStoredArray('k', []);
        expect(globalThis.readStoredArray('k')).toEqual([]);
    });

    test('readStoredArray returns [] for a missing or corrupt key', () => {
        expect(globalThis.readStoredArray('absent')).toEqual([]);
        localStorage.setItem('bad', '{not json');
        expect(globalThis.readStoredArray('bad')).toEqual([]);
    });
});

describe('writeStoredArray quota handling', () => {
    // Throw QuotaExceededError on the first setItem only, then behave normally —
    // simulates a full store that has room again after the reclaim frees space.
    function throwQuotaOnce() {
        const real = Storage.prototype.setItem;
        let thrown = false;
        return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
            if (!thrown) { thrown = true; throw quotaError(); }
            return real.call(this, k, v);
        });
    }

    test('writing the visits array compacts it in place when quota is hit', () => {
        throwQuotaOnce();
        const ok = globalThis.writeStoredArray('walk_visits', visitsWithGeometry(60));
        expect(ok).toBe(true);
        const after = globalThis.readStoredArray('walk_visits');
        // Newest 50 keep geometry; the 10 oldest are trimmed to metadata-only.
        expect(after.filter(v => v.routeCoords !== null)).toHaveLength(50);
        expect(after.filter(v => v.routeCoords === null)).toHaveLength(10);
        expect(after.find(v => v.id === 'v59').routeCoords).toEqual([[1, 2], [3, 4]]);
        expect(after.find(v => v.id === 'v0').routeCoords).toBeNull();
        expect(after.find(v => v.id === 'v0').returnRouteCoords).toBeNull();
    });

    test('a full unrelated write (outbox) reclaims space from persisted visits and retries', () => {
        // Persisted visits are the space hog; the outbox write is what overflows.
        localStorage.setItem('walk_visits', JSON.stringify(visitsWithGeometry(60)));
        throwQuotaOnce();
        const ok = globalThis.writeStoredArray('walk_sync_outbox', [{ id: 'x' }]);
        expect(ok).toBe(true);
        expect(globalThis.readStoredArray('walk_sync_outbox')).toEqual([{ id: 'x' }]);
        const after = globalThis.readStoredArray('walk_visits');
        expect(after.filter(v => v.routeCoords === null)).toHaveLength(10);
        expect(after.filter(v => v.routeCoords !== null)).toHaveLength(50);
    });

    test('local trim of persisted visits is not a synced mutation (raw write only)', () => {
        // reclaimVisitGeometry must write straight to localStorage, never through a
        // synced path, so the cloud copy keeps full geometry. There is no
        // ExplorerSync here; the trim still succeeds, proving it does not depend on
        // (or invoke) the sync layer.
        localStorage.setItem('walk_visits', JSON.stringify(visitsWithGeometry(55)));
        globalThis.ExplorerSync = { mutate: vi.fn() };
        throwQuotaOnce();
        globalThis.writeStoredArray('walk_sync_outbox', [{ id: 'x' }]);
        expect(globalThis.ExplorerSync.mutate).not.toHaveBeenCalled();
        delete globalThis.ExplorerSync;
    });

    test('surfaces an error toast and returns false when quota cannot be reclaimed', () => {
        globalThis.showError = vi.fn();
        // Fewer than the keep-threshold of visits → nothing to trim, no recovery.
        localStorage.setItem('walk_visits', JSON.stringify(visitsWithGeometry(3)));
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaError(); });
        const ok = globalThis.writeStoredArray('walk_visits', visitsWithGeometry(3));
        expect(ok).toBe(false);
        expect(globalThis.showError).toHaveBeenCalledTimes(1);
        delete globalThis.showError;
    });

    test('rethrows non-quota setItem errors', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('disk on fire');
        });
        expect(() => globalThis.writeStoredArray('k', [1])).toThrow('disk on fire');
    });
});
