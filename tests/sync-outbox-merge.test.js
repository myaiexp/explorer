/**
 * Tests for the Case 2 merge against a durable outbox: a reload of a synced
 * account must not let the GET snapshot overrule a mutation still waiting to
 * reach the server, and every queued mutation must reach a real server route.
 *
 * Driven through WanderSync.init() so the order under test is the production one:
 * GET → merge → resume the pump.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, loadSync, setLocation, setLocalStorage, mockFetch, serverTrip,
    drainFlushPump,
} from './helpers/sync-harness.js';
import { jsonResponse } from './helpers/fetch-stub.js';

installSyncLifecycle();

const USER = 'rugged-pine-42';
const ACCOUNT_URL = '/wander/api/' + USER;
const EMPTY_ACCOUNT = { visits: [], favorites: [], savedLocations: [], history: [] };

const consent = () => JSON.stringify({ state: 'accepted', username: USER, token: 'tok' });

// One server row per synced section, in the shape GET /:username emits.
const SERVER_ROWS = {
    visits: serverTrip({ id: 'x', updatedAt: '2024-06-01T00:00:00Z' }),
    history: serverTrip({ id: 'x', updatedAt: '2024-06-01T00:00:00Z' }),
    favorites: { id: 'x', payload: { destLat: 62, destLng: 25 }, updatedAt: '2024-06-01T00:00:00Z' },
    savedLocations: { id: 'x', label: 'Home', value: '62,25', updatedAt: '2024-06-01T00:00:00Z' },
};
const LOCAL_KEYS = {
    visits: 'walk_visits',
    history: 'walk_history',
    favorites: 'walk_favorites',
    savedLocations: 'walk_saved_locations',
};
const ROUTES = {
    visits: 'visits',
    history: 'history',
    favorites: 'favorites',
    savedLocations: 'saved-locations',
};

const stored = key => JSON.parse(localStorage.getItem(key) || '[]');
const requests = method => global.fetch.mock.calls
    .filter(([, opts = {}]) => (opts.method || 'GET') === method)
    .map(([url]) => url);

// Reload a synced account with `outbox` queued and `account` on the server.
async function reload({ outbox, account, local = {} }) {
    setLocation('/wander/' + USER);
    setLocalStorage({
        walk_cloud_backup: consent(),
        walk_sync_outbox: JSON.stringify(outbox),
        ...local,
    });
    const routes = { [ACCOUNT_URL]: { ...EMPTY_ACCOUNT, ...account } };
    Object.values(ROUTES).forEach((route) => {
        routes['DELETE ' + ACCOUNT_URL + '/' + route + '/x'] = {};
        routes['PUT ' + ACCOUNT_URL + '/' + route + '/x'] = {};
    });
    mockFetch(routes);
    loadSync();
    await window.WanderSync.init();
}

describe('Case 2 merge honours queued deletes', () => {
    test.each(Object.keys(SERVER_ROWS))('%s: a queued delete keeps the server row out of localStorage', async (section) => {
        await reload({
            outbox: [{ section, op: 'delete', id: 'x' }],
            account: { [section]: [SERVER_ROWS[section]] },
        });
        expect(stored(LOCAL_KEYS[section])).toEqual([]);

        await drainFlushPump();
        expect(stored(LOCAL_KEYS[section])).toEqual([]);
        expect(requests('DELETE')).toEqual([ACCOUNT_URL + '/' + ROUTES[section] + '/x']);
        expect(window.WanderSync._outbox.peek()).toEqual([]);
    });

    test('a delete queued after a put wins: the last op on an id decides', async () => {
        await reload({
            outbox: [
                { section: 'visits', op: 'put', id: 'x', data: { id: 'x' } },
                { section: 'visits', op: 'delete', id: 'x' },
            ],
            account: { visits: [SERVER_ROWS.visits] },
        });
        expect(stored('walk_visits')).toEqual([]);
    });

    test('a delete in another section leaves a same-id row alone', async () => {
        await reload({
            outbox: [{ section: 'favorites', op: 'delete', id: 'x' }],
            account: { visits: [SERVER_ROWS.visits] },
        });
        expect(stored('walk_visits').map(row => row.id)).toEqual(['x']);
    });

    test('rows with no queued mutation still merge in', async () => {
        await reload({
            outbox: [{ section: 'visits', op: 'delete', id: 'other' }],
            account: { visits: [SERVER_ROWS.visits] },
        });
        expect(stored('walk_visits').map(row => row.id)).toEqual(['x']);
    });
});

describe('Case 2 merge honours queued puts', () => {
    // App-written rows carry no updatedAt, so last-write-wins alone reads them as
    // epoch 0 and hands the row to the stale server copy.
    const localVisit = { id: 'x', destName: 'local edit' };

    test('a queued put keeps the local row over a newer-stamped server row', async () => {
        await reload({
            outbox: [{ section: 'visits', op: 'put', id: 'x', data: localVisit }],
            account: { visits: [{ ...SERVER_ROWS.visits, destName: 'stale server' }] },
            local: { walk_visits: JSON.stringify([localVisit]) },
        });
        expect(stored('walk_visits')).toEqual([localVisit]);
    });

    test('a put queued after a delete wins: the row was re-added locally', async () => {
        await reload({
            outbox: [
                { section: 'visits', op: 'delete', id: 'x' },
                { section: 'visits', op: 'put', id: 'x', data: localVisit },
            ],
            account: { visits: [{ ...SERVER_ROWS.visits, destName: 'stale server' }] },
            local: { walk_visits: JSON.stringify([localVisit]) },
        });
        expect(stored('walk_visits')).toEqual([localVisit]);
    });

    test('a queued put with no local row still takes the server row', async () => {
        await reload({
            outbox: [{ section: 'visits', op: 'put', id: 'x', data: localVisit }],
            account: { visits: [SERVER_ROWS.visits] },
        });
        expect(stored('walk_visits').map(row => row.id)).toEqual(['x']);
    });
});

describe('the pump waits for the merge', () => {
    test('a delete made while the GET is in flight stays queued until the merge has seen it', async () => {
        let answerGet;
        setLocation('/wander/' + USER);
        setLocalStorage({ walk_cloud_backup: consent() });
        global.fetch = vi.fn((url, opts = {}) => {
            if ((opts.method || 'GET') === 'GET') {
                return new Promise((res) => { answerGet = res; });
            }
            return Promise.resolve(jsonResponse({}));
        });
        loadSync();
        const init = window.WanderSync.init();

        window.WanderSync.mutate('visits', 'delete', 'x');
        await drainFlushPump();
        expect(requests('DELETE')).toEqual([]);

        answerGet(jsonResponse({ ...EMPTY_ACCOUNT, visits: [SERVER_ROWS.visits] }));
        await init;
        await drainFlushPump();

        expect(stored('walk_visits')).toEqual([]);
        expect(requests('DELETE')).toEqual([ACCOUNT_URL + '/visits/x']);
        expect(window.WanderSync._outbox.peek()).toEqual([]);
    });

    test('a failed GET still releases the queue', async () => {
        setLocation('/wander/' + USER);
        setLocalStorage({
            walk_cloud_backup: consent(),
            walk_sync_outbox: JSON.stringify([{ section: 'visits', op: 'delete', id: 'x' }]),
        });
        mockFetch({ [ACCOUNT_URL]: { status: 500 }, ['DELETE ' + ACCOUNT_URL + '/visits/x']: {} });
        loadSync();
        await window.WanderSync.init();
        await drainFlushPump();
        expect(window.WanderSync._outbox.peek()).toEqual([]);
    });

    test('a rejected state machine still releases the queue', async () => {
        setLocation('/wander/' + USER);
        setLocalStorage({ walk_cloud_backup: consent() });
        mockFetch({ [ACCOUNT_URL]: EMPTY_ACCOUNT, ['DELETE ' + ACCOUNT_URL + '/visits/x']: {} });
        loadSync();
        await window.WanderSync._runInit();
        window.WanderSync._runInit = () => Promise.reject(new Error('boom'));

        await expect(window.WanderSync.init()).rejects.toThrow('boom');
        window.WanderSync.mutate('visits', 'delete', 'x');
        await drainFlushPump();
        expect(window.WanderSync._outbox.peek()).toEqual([]);
    });
});

describe('outbox entries reach real server routes', () => {
    test('every section flushes to a path sections.ts registers', async () => {
        const src = readFileSync(resolve(process.cwd(), 'server/src/routes/sections.ts'), 'utf8');
        const registered = [...src.matchAll(/^\s+path: '([^']+)',$/gm)].map(m => m[1]);
        expect(registered).toHaveLength(4);

        await reload({ outbox: [], account: {} });
        const sections = window.SyncSections.DATA_SECTIONS;
        sections.forEach(section => window.WanderSync.mutate(section, 'delete', 'x'));
        await drainFlushPump();

        const flushed = requests('DELETE').map(url => url.split('/').at(-2));
        expect(new Set(flushed)).toEqual(new Set(registered));
    });
});
