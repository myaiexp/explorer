/**
 * Tests for restoreSections's failure path (finding #7779).
 *
 * The success toast ('your previous data was restored') lives in
 * sync-sections.test.js next to the quota-overflow switch. This file pins the
 * remaining data-loss branch: setItem throws while putting the snapshot back,
 * restoreSections returns false, the data-loss toast fires, and the tentative
 * token is rolled back. Kept out of sync-sections.test.js so that already-long
 * file does not grow further.
 */
import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, loadSync, setLocation, setLocalStorage, mockFetch,
} from './helpers/sync-harness.js';

installSyncLifecycle();

const SECTION_KEYS = ['walk_visits', 'walk_favorites', 'walk_saved_locations', 'walk_history'];

function quotaError() {
    const e = new Error('quota exceeded');
    e.name = 'QuotaExceededError';
    return e;
}

describe('restoreSections failure', () => {
    test('returns false when setItem throws', () => {
        setLocalStorage({ walk_visits: JSON.stringify([{ id: 'local-v' }]) });
        const snap = globalThis.SyncSections.snapshotSections();
        const real = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
            if (k === 'walk_visits') throw quotaError();
            return real.call(this, k, v);
        });
        expect(globalThis.SyncSections.restoreSections(snap)).toBe(false);
    });

    test('account switch: restore setItem throw surfaces the data-loss toast', async () => {
        // Same Case 4/5 setup as the successful-rollback test in
        // sync-sections.test.js, but every section write throws — apply fails
        // (so the wipe must roll back) AND restoreSections's raw setItem fails
        // too. That is the remaining data-loss path.
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
            walk_history: JSON.stringify([{ id: 'local-h' }]),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            '/explorer/api/mossy-fern-7': {
                visits: [{ id: 'server-v' }], favorites: [], savedLocations: [], history: [],
            },
        });
        globalThis.showError = vi.fn();
        loadSync();

        const restoreSpy = vi.spyOn(globalThis.SyncSections, 'restoreSections');
        const real = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
            if (SECTION_KEYS.includes(k)) throw quotaError();
            return real.call(this, k, v);
        });

        await window.ExplorerSync.init();

        expect(restoreSpy).toHaveReturnedWith(false);
        expect(globalThis.showError).toHaveBeenCalledWith(
            expect.stringContaining('some local data could not be restored'),
        );
        // onFail → rollbackAdopt: the tentative mossy-fern token is dropped,
        // device stays on the account the (now unrestorable) data belonged to.
        expect(window.ExplorerSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
        delete globalThis.showError;
    });
});
