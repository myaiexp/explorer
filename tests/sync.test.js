/**
 * Tests for sync.js — ExplorerSync
 *
 * Loading strategy: sync.js is a non-module IIFE that sets window.ExplorerSync.
 * We use new Function() to execute it in the jsdom global context between tests
 * (standard test-harness pattern for non-module browser scripts; the source file
 * is a static local asset, not user input, so code-injection is not a concern).
 *
 * Note: security-hook warning acknowledged — new Function() is intentional here.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Load sync.js source once ─────────────────────────────────────────────────

const SYNC_SRC = readFileSync(resolve(__dirname, '../sync.js'), 'utf8');

// Execute the IIFE in the jsdom global scope. new Function() is used here
// deliberately to bootstrap a non-module browser script in the test environment.
function loadSync() {
    delete window.ExplorerSync;
    // new Function with static local file content — not user-supplied input
    const fn = new Function(SYNC_SRC); // eslint-disable-line no-new-func
    fn.call(window);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setLocation(pathname) {
    Object.defineProperty(window, 'location', {
        value: { pathname, assign: vi.fn() },
        writable: true,
        configurable: true,
    });
}

function setLocalStorage(obj) {
    localStorage.clear();
    Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, v));
}

/**
 * Build a mock fetch keyed by "METHOD url" or bare url for GET.
 * Value: body object (status defaults 200) or { status, headers?, ...body }.
 * Special value 'OFFLINE' → network rejection.
 */
function mockFetch(routes) {
    global.fetch = vi.fn((url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        const keyed = method + ' ' + url;
        let config = routes[keyed] ?? routes[url];

        if (config === 'OFFLINE') {
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        if (config === undefined) {
            return Promise.resolve({
                ok: false, status: 404,
                headers: new Headers(),
                json: () => Promise.resolve({}),
            });
        }

        const status = config.status ?? 200;
        const responseHeaders = new Headers(config.headers ?? {});
        const body = { ...config };
        delete body.status;
        delete body.headers;

        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: responseHeaders,
            json: () => Promise.resolve(body),
        });
    });
}

function mockFetchOffline() {
    global.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
}

async function flushPromises() {
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
}

function setupAnonymous() {
    setLocation('/explorer/');
    setLocalStorage({});
    loadSync();
}

async function setupAccepted(username) {
    setLocation('/explorer/' + username);
    setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username }) });
    mockFetch({
        ['/explorer/api/' + username]: { visits: [], favorites: [], savedLocations: [], history: [] },
    });
    loadSync();
    await window.ExplorerSync.init();
    global.fetch = vi.fn();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete window.ExplorerSyncUI;
    setLocation('/explorer/');
    loadSync();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

// ── ExplorerSync.init ─────────────────────────────────────────────────────────

describe('ExplorerSync.init', () => {
    test('anonymous when no flag and no URL segment', async () => {
        setLocation('/explorer/');
        setLocalStorage({});
        loadSync();
        await window.ExplorerSync.init();
        expect(window.ExplorerSync.getState().state).toBe('anonymous');
    });

    test('accepted when flag matches URL segment and merges server data', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }) });
        mockFetch({
            '/explorer/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        loadSync();
        await window.ExplorerSync.init();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
    });

    test('URL segment with empty localStorage auto-loads without confirm', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({});
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [{ id: '1', updatedAt: '2024-01-01T00:00:00Z' }],
                favorites: [], savedLocations: [], history: [],
            },
        });
        const confirmSpy = vi.spyOn(window, 'confirm');
        loadSync();
        await window.ExplorerSync.init();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toHaveLength(1);
        expect(window.ExplorerSync.getState().state).toBe('accepted');
    });

    test('URL segment with non-empty localStorage prompts confirm; cancel strips URL', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({ walk_visits: '[{"id":"old"}]' });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        loadSync();
        await window.ExplorerSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'old' }]);
        expect(window.ExplorerSync.getState().state).toBe('anonymous');
    });

    test('URL segment with non-empty localStorage prompts confirm; accept loads server data', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({ walk_visits: '[{"id":"old"}]' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
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

    test('declined flag with no URL segment stays declined', async () => {
        setLocation('/explorer/');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'declined' }) });
        loadSync();
        await window.ExplorerSync.init();
        expect(window.ExplorerSync.getState().state).toBe('declined');
    });
});

// ── ExplorerSync.mutate ───────────────────────────────────────────────────────

describe('ExplorerSync.mutate', () => {
    test('no-op when anonymous', async () => {
        setupAnonymous();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await flushPromises();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(localStorage.getItem('walk_sync_outbox')).toBeNull();
    });

    test('no-op when declined', async () => {
        setLocation('/explorer/');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'declined' }) });
        loadSync();
        await window.ExplorerSync.init();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await flushPromises();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('enqueues PUT when accepted and clears outbox on 204', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /explorer/api/rugged-pine-42/visits/uuid-1': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await flushPromises();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('outbox persists to localStorage before flush resolves', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetchOffline();
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        // Synchronous check — outbox is written before async flush fires
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
    });

    test('respects Retry-After on 429', async () => {
        vi.useFakeTimers();
        await setupAccepted('rugged-pine-42');

        let callCount = 0;
        global.fetch = vi.fn(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    ok: false, status: 429,
                    headers: new Headers({ 'Retry-After': '10' }),
                    json: () => Promise.resolve({}),
                });
            }
            return Promise.resolve({
                ok: true, status: 204,
                headers: new Headers(),
                json: () => Promise.resolve({}),
            });
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        // Flush microtask queue to let the first fetch fire and resolve
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(11000);
        // Flush microtasks after timer fires
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(callCount).toBe(2);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
    });

    test('drops entry on 4xx (not 429) and warns', async () => {
        await setupAccepted('rugged-pine-42');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockFetch({
            'PUT /explorer/api/rugged-pine-42/visits/uuid-bad': { status: 400 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-bad', { id: 'uuid-bad' });
        await flushPromises();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
    });
});

// ── ExplorerSync.accept ───────────────────────────────────────────────────────

describe('ExplorerSync.accept', () => {
    beforeEach(() => {
        setLocation('/explorer/');
        setLocalStorage({});
        loadSync();
    });

    test('generates UUID for legacy saved_locations missing id', async () => {
        localStorage.setItem('walk_saved_locations', JSON.stringify([{ label: 'home', value: 'Home St 1' }]));
        mockFetch({
            'POST /explorer/api/accounts': { username: 'rugged-pine-42' },
            'POST /explorer/api/rugged-pine-42/import': { status: 204 },
        });
        loadSync();
        await window.ExplorerSync.accept();
        const stored = JSON.parse(localStorage.getItem('walk_saved_locations'));
        expect(stored[0]).toHaveProperty('id');
        expect(stored[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('rewrites URL and fires state-change event on success', async () => {
        mockFetch({
            'POST /explorer/api/accounts': { username: 'rugged-pine-42' },
            'POST /explorer/api/rugged-pine-42/import': { status: 204 },
        });
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        loadSync();
        await window.ExplorerSync.accept();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/rugged-pine-42');
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });

    test('does not write flag if import POST fails', async () => {
        mockFetch({
            'POST /explorer/api/accounts': { username: 'rugged-pine-42' },
            'POST /explorer/api/rugged-pine-42/import': { status: 500 },
        });
        loadSync();
        await expect(window.ExplorerSync.accept()).rejects.toThrow();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
        expect(window.ExplorerSync.getState().state).toBe('anonymous');
    });
});

// ── ExplorerSync.decline ─────────────────────────────────────────────────────

describe('ExplorerSync.decline', () => {
    test('sets declined flag and fires state-change event', () => {
        setLocation('/explorer/');
        setLocalStorage({});
        loadSync();
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        window.ExplorerSync.decline();
        expect(window.ExplorerSync.getState().state).toBe('declined');
        expect(JSON.parse(localStorage.getItem('walk_cloud_backup'))).toEqual({ state: 'declined' });
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });
});

// ── ExplorerSync.deleteAccount ───────────────────────────────────────────────

describe('ExplorerSync.deleteAccount', () => {
    test('clears flag, outbox, strips URL, fires state-change', async () => {
        await setupAccepted('rugged-pine-42');
        localStorage.setItem('walk_sync_outbox', JSON.stringify([{ section: 'visits', op: 'put', id: 'x' }]));
        mockFetch({
            'DELETE /explorer/api/rugged-pine-42': { status: 204 },
        });
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        await window.ExplorerSync.deleteAccount();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'anonymous', username: null });
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
        expect(localStorage.getItem('walk_sync_outbox')).toBeNull();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/');
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });
});

// ── ExplorerSync.requestConsent ──────────────────────────────────────────────

describe('ExplorerSync.requestConsent', () => {
    test('falls back to window.confirm when no ExplorerSyncUI hook', async () => {
        setLocation('/explorer/');
        setLocalStorage({});
        mockFetch({
            'POST /explorer/api/accounts': { username: 'rugged-pine-42' },
            'POST /explorer/api/rugged-pine-42/import': { status: 204 },
        });
        loadSync();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const result = await window.ExplorerSync.requestConsent();
        expect(result).toBe('accepted');
    });

    test('uses ExplorerSyncUI.showConsentToast when registered', async () => {
        setLocation('/explorer/');
        setLocalStorage({});
        loadSync();
        window.ExplorerSyncUI = {
            showConsentToast: vi.fn(() => Promise.resolve('declined')),
        };
        const result = await window.ExplorerSync.requestConsent();
        expect(window.ExplorerSyncUI.showConsentToast).toHaveBeenCalled();
        expect(result).toBe('declined');
    });
});
