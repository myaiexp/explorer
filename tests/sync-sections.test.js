/**
 * Tests for sync-sections.js — read/merge/normalize/wipe of the four synced
 * collections.
 *
 * The module is pure local-data shaping with no network of its own, so its
 * appliers are driven here through the init paths that select them: Case 2 uses
 * mergeSection, Cases 3/4/5 use populateSection (with wipeSections deferred into
 * the download's success path). What each test asserts is the section layer's
 * output in localStorage; the state machine around it lives in sync.test.js.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, loadSync, setLocation, setLocalStorage, mockFetch,
} from './helpers/sync-harness.js';

installSyncLifecycle();

// ── #1566 — mergeSection last-write-wins + account-switch wipe ─────────────────
// mergeSection is reachable only via init Case 2 (URL matches stored accepted
// username → GET → merge per section by updatedAt). The account-switch path is
// Case 4/5 (URL present but stored username differs → confirm → wipe + populate).

describe('#1566 mergeSection last-write-wins', () => {
    // Drive a single visits row through init Case 2 with a colliding id, varying
    // only the server row's updatedAt relative to the local row's.
    async function initCase2WithServerVisit(serverVisit) {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
            walk_visits: JSON.stringify([{ id: '1', updatedAt: '2024-06-01T00:00:00Z', name: 'local' }]),
        });
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [serverVisit], favorites: [], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();
        return JSON.parse(localStorage.getItem('walk_visits'));
    }

    test('Branch A: server row older than local → local wins', async () => {
        const merged = await initCase2WithServerVisit(
            { id: '1', updatedAt: '2024-01-01T00:00:00Z', name: 'server' }, // older
        );
        expect(merged).toHaveLength(1);
        expect(merged[0].name).toBe('local');
    });

    test('Branch B: server row updatedAt EQUAL to local → server wins (pins `>=`)', async () => {
        const merged = await initCase2WithServerVisit(
            { id: '1', updatedAt: '2024-06-01T00:00:00Z', name: 'server' }, // equal
        );
        // PIN current behavior: mergeSection compares with `rt >= et`, so a server
        // row with an EQUAL timestamp overwrites the local row (server wins ties).
        // Mutating `>=` → `>` makes this assertion RED.
        expect(merged[0].name).toBe('server');
    });

    test('Branch C: server row missing updatedAt → treated as epoch 0, local wins', async () => {
        const merged = await initCase2WithServerVisit(
            { id: '1', name: 'server' }, // no updatedAt → rt = 0 < local's et
        );
        expect(merged[0].name).toBe('local');
    });

    test('account switch: different stored username wipes local sections before load', async () => {
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
            walk_history: JSON.stringify([{ id: 'local-h' }]),
        });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            // Server response deliberately OMITS `history`. If wipeSections() runs
            // before populate, walk_history disappears; if it were skipped, the stale
            // local history row would survive — making this test the wipe discriminator.
            '/explorer/api/mossy-fern-7': {
                visits: [{ id: 'server-v' }], favorites: [], savedLocations: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();

        expect(confirmSpy).toHaveBeenCalled();
        expect(confirmSpy.mock.calls[0][0]).toContain('Switching to account mossy-fern-7 from rugged-pine-42');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'server-v' }]);
        // wiped by wipeSections() and never repopulated (server omitted `history`)
        expect(localStorage.getItem('walk_history')).toBeNull();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'mossy-fern-7' });
    });
});

// ── account-switch data-loss guard (audit) ────────────────────────────────────
// Case 4/5 confirms, then downloads the new account and wipes+populates local
// storage. The wipe is deferred into loadAccount's success path, so a GET that
// fails AFTER the user confirmed (network error or non-ok) must leave the
// device's existing walks/favourites/history exactly as they were — a single
// transient failure must never be permanent data loss. Sibling of the
// success-path wipe test above; this pins the failure path.

describe('account switch: a failed download after confirm preserves local data', () => {
    function setupSwitch(fetchConfig) {
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
            walk_history: JSON.stringify([{ id: 'local-h' }]),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({ '/explorer/api/mossy-fern-7': fetchConfig });
        loadSync();
    }

    function expectLocalDataSurvived() {
        // The wipe never ran — both local sections are byte-for-byte intact.
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        expect(JSON.parse(localStorage.getItem('walk_history'))).toEqual([{ id: 'local-h' }]);
        // rollbackToken nulled the tentatively-set token; no foreign account bound.
        const state = window.ExplorerSync.getState();
        expect(state.token).toBeNull();
        expect(state.username).toBeNull();
    }

    test('non-ok response (500) after confirm: local sections survive, token rolled back', async () => {
        setupSwitch({ status: 500 });
        await window.ExplorerSync.init();
        expectLocalDataSurvived();
    });

    test('network error after confirm: local sections survive, token rolled back', async () => {
        setupSwitch('OFFLINE');
        await window.ExplorerSync.init();
        expectLocalDataSurvived();
    });
});

// ── #2065 — favorites round-trip through cloud sync ────────────────────────────
// The server stores favorites as {id, username, payload, updatedAt} where payload is
// the flat favorite blob (unlike visits/history/savedLocations, which have typed
// columns and come back already-flat). On sync-down the client must UNWRAP payload
// back to the flat shape the renderer reads (f.destLat, f.destName, …) — writing the
// raw row verbatim leaves favorites as {id, payload:{…}}, so f.destLat is undefined and
// the renderer crashes on `f.destLat.toFixed(6)`.

describe('#2065 favorites round-trip (sync-down unwraps payload)', () => {
    const serverFavRow = {
        id: 'fav-1',
        username: 'rugged-pine-42',
        payload: { id: 'fav-1', destLat: 60.1, destLng: 24.9, destName: 'Park', distance: 3 },
        updatedAt: '2024-06-01T00:00:00Z',
    };

    test('init Case 2 merge: favorites are stored flat, not payload-wrapped', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
        });
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [], favorites: [serverFavRow], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();
        const stored = JSON.parse(localStorage.getItem('walk_favorites'));
        expect(stored).toHaveLength(1);
        // Flat shape the renderer reads — NOT {payload:{…}}
        expect(stored[0].destLat).toBe(60.1);
        expect(stored[0].destName).toBe('Park');
        expect(stored[0].id).toBe('fav-1');
        expect(stored[0].payload).toBeUndefined();
        // updatedAt preserved so future merges can do last-write-wins
        expect(stored[0].updatedAt).toBe('2024-06-01T00:00:00Z');
    });

    test('init Case 4/5 populate: favorites from a switched account are stored flat', async () => {
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            '/explorer/api/mossy-fern-7': {
                visits: [], favorites: [{ ...serverFavRow, username: 'mossy-fern-7' }], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();
        const stored = JSON.parse(localStorage.getItem('walk_favorites'));
        expect(stored).toHaveLength(1);
        expect(stored[0].destLat).toBe(60.1);
        expect(stored[0].payload).toBeUndefined();
    });

    test('non-favorite sections (visits) are still stored verbatim (not unwrapped)', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
        });
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [{ id: 'v1', destLat: 61.0, updatedAt: '2024-06-01T00:00:00Z' }],
                favorites: [], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();
        const stored = JSON.parse(localStorage.getItem('walk_visits'));
        expect(stored[0]).toMatchObject({ id: 'v1', destLat: 61.0 });
    });
});

// ── section writes are quota-aware (audit #5397 / #5408) ─────────────────────
// mergeSection/populateSection used to call localStorage.setItem raw, skipping
// storage.js's safeSetItem. That made a sync-down — the largest write the app
// ever makes, since the cloud copy retains the full route geometry storage.js
// trims locally — throw straight out of loadAccount's DATA_SECTIONS.forEach,
// where the trailing .catch swallowed it. Both appliers now delegate to
// writeStoredArray, so quota is recovered-or-reported instead of thrown.

describe('quota-full sync-down', () => {
    const SECTION_KEYS = ['walk_visits', 'walk_favorites', 'walk_saved_locations', 'walk_history'];

    function quotaError() {
        const e = new Error('quota exceeded');
        e.name = 'QuotaExceededError';
        return e;
    }

    // A store with room for the small rows already on the device but not for the
    // fatter server payload: a section write over `limit` bytes throws. This is the
    // shape that matters — a blanket "every write throws" would also block the
    // rollback, which in reality re-writes bytes that demonstrably just fit.
    function quotaCeiling(limit) {
        const real = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
            if (SECTION_KEYS.includes(k) && String(v).length > limit) { throw quotaError(); }
            return real.call(this, k, v);
        });
    }

    // Server rows padded well past the ceiling; local rows stay far under it.
    const fatVisit = { id: 'server-v', note: 'x'.repeat(400) };

    test('Case 2 merge: a section that overflows quota is reported, not thrown', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
        });
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [fatVisit], favorites: [], savedLocations: [], history: [],
            },
        });
        globalThis.showError = vi.fn();
        loadSync();
        quotaCeiling(200);

        const rendered = vi.fn();
        window.addEventListener('explorer-sync-state-change', rendered);
        // A raw setItem would reject this await with QuotaExceededError.
        await expect(window.ExplorerSync.init()).resolves.toBeUndefined();
        window.removeEventListener('explorer-sync-state-change', rendered);

        // storage.js surfaced the full-storage toast rather than failing silently.
        expect(globalThis.showError).toHaveBeenCalled();
        // Nothing was wiped on this path, so the failed write left the prior value
        // in place — degraded, not lost.
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        // Still 'accepted', and the UI is still told to re-render: the sections that
        // did land must not be stranded behind a missing state-change event.
        expect(window.ExplorerSync.getState().state).toBe('accepted');
        expect(rendered).toHaveBeenCalled();
        delete globalThis.showError;
    });

    test('account switch: an apply that overflows quota rolls the wipe back', async () => {
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
            walk_history: JSON.stringify([{ id: 'local-h' }]),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            '/explorer/api/mossy-fern-7': {
                visits: [fatVisit], favorites: [], savedLocations: [], history: [],
            },
        });
        globalThis.showError = vi.fn();
        loadSync();
        quotaCeiling(200);

        await window.ExplorerSync.init();

        // wipeSections() ran before the failed populate; without the rollback the
        // device would be left erased holding only part of the new account.
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        expect(JSON.parse(localStorage.getItem('walk_history'))).toEqual([{ id: 'local-h' }]);
        // The switch did not happen, so no foreign account is bound.
        const state = window.ExplorerSync.getState();
        expect(state.token).toBeNull();
        expect(state.username).toBeNull();
        expect(globalThis.showError).toHaveBeenCalledWith(
            expect.stringContaining('your previous data was restored'),
        );
        delete globalThis.showError;
    });

    test('restoreSections puts an absent section back as absent, not as []', () => {
        setLocalStorage({ walk_visits: JSON.stringify([{ id: 'local-v' }]) });
        const snap = globalThis.SyncSections.snapshotSections();
        globalThis.SyncSections.populateSection('history', [{ id: 'server-h' }]);
        expect(globalThis.SyncSections.restoreSections(snap)).toBe(true);
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        expect(localStorage.getItem('walk_history')).toBeNull();
    });
});

// ── isLocalStorageEmpty ───────────────────────────────────────────────────────

describe('isLocalStorageEmpty', () => {
    // isLocalStorageEmpty swallows JSON.parse errors and treats a corrupt section
    // as empty (NOT as non-empty — the audit suggestion's "returns false"
    // misreads the catch). Exercised via init Case 3, which only auto-loads when
    // isLocalStorageEmpty() returns true. A throwing parse would propagate out of
    // init and reject this await.
    test('treats a corrupt-JSON section as empty (catch branch) → Case 3 auto-loads', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({ walk_visits: '{ not valid json' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);   // Case 3 is consent-gated
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [{ id: 'server-1' }], favorites: [], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.ExplorerSync.init();
        expect(window.ExplorerSync.getState().state).toBe('accepted');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'server-1' }]);
    });
});
