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
// sync.js's IIFE reads globalThis.createSyncFlushWorker (sync-flush.js) and
// globalThis.SyncSections (sync-sections.js) at load time, so both sibling
// modules must run first — mirrors index.html's script order.
import FLUSH_SRC from '../sync-flush.js?raw';
import SECTIONS_SRC from '../sync-sections.js?raw';
import SYNC_SRC from '../sync.js?raw';
// Side-effect import: storage.js owns the walk_* key strings and readStoredArray
// that sync-sections.js resolves off globalThis at call time. Importing it runs
// its top-level globalThis assignments once, so those globals exist before any
// ExplorerSync method runs (mirrors prod, where both scripts have executed by the
// time init() is called). Values are constant, so a single load suffices.
import '../storage.js';
// Side-effect import: net.js registers globalThis.fetchWithTimeout, which
// sync.js's apiFetch now calls. Load it before loadSync() runs the IIFE.
import '../net.js';

// ── Load the sync scripts once ────────────────────────────────────────────────

// Execute each IIFE in the jsdom global scope. new Function() is used here
// deliberately to bootstrap non-module browser scripts in the test environment.
// Order matches index.html: the flush worker + section helpers register their
// globals before sync.js's IIFE consumes them.
function loadSync() {
    delete window.ExplorerSync;
    // new Function with static local file content — not user-supplied input
    new Function(FLUSH_SRC).call(window);    // eslint-disable-line no-new-func
    new Function(SECTIONS_SRC).call(window); // eslint-disable-line no-new-func
    new Function(SYNC_SRC).call(window);     // eslint-disable-line no-new-func
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setLocation(pathname, hash) {
    Object.defineProperty(window, 'location', {
        value: { pathname, hash: hash || '', origin: 'https://mase.fi', assign: vi.fn() },
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

// Drain the async pipeline so assertions run after sync.js has fully settled.
// sync.js flushes its outbox one entry per setTimeout(0) "tick" — each
// successful upsert reschedules the next via scheduleFlush(0) — so a fixed
// handful of awaits is fragile: adding an async hop (or draining one more
// entry) could let a test resolve before the flush completes and pass
// vacuously. Instead we yield a generous, bounded number of real-timer
// macrotask turns; each turn fires one pending setTimeout(0) and drains all
// microtasks around it, advancing the reschedule chain by exactly one hop.
// FLUSH_TURNS is far above any realistic chain depth (current max ~2 hops),
// so the helper stays correct as the pipeline grows.
// Safe only under real timers — every caller runs without fake timers (the
// fake-timer tests drive the clock explicitly via advanceTimersByTimeAsync).
const FLUSH_TURNS = 20;
async function flushPromises() {
    for (let i = 0; i < FLUSH_TURNS; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

function setupAnonymous() {
    setLocation('/explorer/');
    setLocalStorage({});
    loadSync();
}

async function setupAccepted(username) {
    setLocation('/explorer/' + username);
    setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username, token: 'tok-' + username }) });
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

    test('URL segment + token fragment with empty localStorage loads after consent', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/explorer/api/rugged-pine-42': {
                visits: [{ id: '1', updatedAt: '2024-01-01T00:00:00Z' }],
                favorites: [], savedLocations: [], history: [],
            },
        });
        // Adopting a URL-sourced account binds this browser to it, so it requires
        // explicit consent even on an empty device (shared-link hijack guard).
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        loadSync();
        await window.ExplorerSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(confirmSpy.mock.calls[0][0]).toContain('Load shared backup account rugged-pine-42');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toHaveLength(1);
        expect(window.ExplorerSync.getState().state).toBe('accepted');
        // The token from the fragment is captured and persisted to the record.
        expect(window.ExplorerSync.getState().token).toBe('tok-rp42');
        expect(JSON.parse(localStorage.getItem('walk_cloud_backup')).token).toBe('tok-rp42');
    });

    test('URL segment + token on a fresh device: declining consent stays anonymous and uploads nothing', async () => {
        // Security regression (audit): opening someone else's shared link must not
        // silently bind a fresh browser to their account. Declining the prompt
        // issues no request, strips the URL, and leaves the browser anonymous so
        // no future mutation can sync to the link owner's account.
        setLocation('/explorer/evil-acct-1', '#t=tok-evil');
        setLocalStorage({});
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.ExplorerSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/');
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
        expect(localStorage.getItem('walk_visits')).toBeNull();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
    });

    test('URL segment WITHOUT token fragment on a fresh device does NOT auto-load', async () => {
        // No flag, empty localStorage, bare link (no #t=) → no credential, so the
        // app cannot fetch the account. It must stay anonymous and issue no request.
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({});
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.ExplorerSync.init();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.ExplorerSync.getState().state).toBe('anonymous');
        expect(localStorage.getItem('walk_visits')).toBeNull();
    });

    test('URL segment with non-empty localStorage prompts confirm; cancel strips URL', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
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
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
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
            'POST /explorer/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
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
            'POST /explorer/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /explorer/api/rugged-pine-42/import': { status: 204 },
        });
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        loadSync();
        await window.ExplorerSync.accept();
        // The secret token rides in the URL fragment so the link itself is the credential.
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/rugged-pine-42#t=tok-rp42');
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' });
        expect(window.ExplorerSync.getState().link).toBe('https://mase.fi/explorer/rugged-pine-42#t=tok-rp42');
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });

    test('does not write flag if import POST fails', async () => {
        mockFetch({
            'POST /explorer/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
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
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
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
            'POST /explorer/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
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

// ── restored backup invisible until reload (audit) ────────────────────────────
// init Case 2's own-device merge rewrites localStorage but historically fired no
// explorer-sync-state-change event, so app.js never re-rendered the merged rows —
// a restored backup stayed invisible until a manual reload. The merge path now
// fires the event on success (via loadAccount's onSuccess = fireStateChange) so
// the app.js refreshDataViews hook runs; a failed GET must NOT fire it.

describe('init Case 2 merge fires state-change so the UI re-renders', () => {
    function setupCase2(fetchConfig) {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
        });
        mockFetch({ '/explorer/api/rugged-pine-42': fetchConfig });
    }

    test('own-device merge dispatches explorer-sync-state-change on success', async () => {
        setupCase2({
            visits: [{ id: 'server-1', updatedAt: '2024-06-01T00:00:00Z' }],
            favorites: [], savedLocations: [], history: [],
        });
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        loadSync();
        await window.ExplorerSync.init();
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });

    test('a failed merge GET does NOT fire state-change (fires only on success)', async () => {
        setupCase2({ status: 500 });
        const eventSpy = vi.fn();
        window.addEventListener('explorer-sync-state-change', eventSpy);
        loadSync();
        await window.ExplorerSync.init();
        expect(eventSpy).not.toHaveBeenCalled();
        window.removeEventListener('explorer-sync-state-change', eventSpy);
    });
});

// ── #1567 — outbox flush: DELETE op, 5xx backoff, multi-entry drain ────────────

describe('#1567 outbox flush DELETE / backoff / drain', () => {
    test('delete op sends DELETE with no body and clears entry on 204', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'DELETE /explorer/api/rugged-pine-42/visits/uuid-del': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'delete', 'uuid-del', undefined);
        await flushPromises();

        const deleteCall = global.fetch.mock.calls.find(c => (c[1] && c[1].method) === 'DELETE');
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[0]).toBe('/explorer/api/rugged-pine-42/visits/uuid-del');
        expect(deleteCall[1].body).toBeUndefined();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('5xx triggers first backoff step (1000ms) then retry succeeds', async () => {
        vi.useFakeTimers();
        await setupAccepted('rugged-pine-42');

        let callCount = 0;
        global.fetch = vi.fn(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({
                    ok: false, status: 500,
                    headers: new Headers(),
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
        // Let the first fetch fire and resolve (microtasks only — no timer yet)
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

        // BACKOFF_STEPS[0] is exactly 1000ms — retry must NOT fire before then.
        // Mutating the first backoff step (e.g. 1000 → 500) makes this RED.
        await vi.advanceTimersByTimeAsync(999);
        expect(callCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(callCount).toBe(2);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
    });

    test('two queued entries drain in order via post-flush reschedule', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /explorer/api/rugged-pine-42/visits/uuid-1': { status: 204 },
            'PUT /explorer/api/rugged-pine-42/visits/uuid-2': { status: 204 },
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        // Both enqueued synchronously before the async flush drains either
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(2);

        await flushPromises();

        const putUrls = global.fetch.mock.calls
            .filter(c => (c[1] && c[1].method) === 'PUT')
            .map(c => c[0]);
        // FIFO order proves the post-success scheduleFlush(0) reschedule fired for entry 2
        expect(putUrls).toEqual([
            '/explorer/api/rugged-pine-42/visits/uuid-1',
            '/explorer/api/rugged-pine-42/visits/uuid-2',
        ]);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('_outbox.flush() resolves once the queue drains (event-based, not polled)', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /explorer/api/rugged-pine-42/visits/uuid-1': { status: 204 },
            'PUT /explorer/api/rugged-pine-42/visits/uuid-2': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(2);
        // Awaiting the returned promise must resolve when settleFlushWaiters fires
        // on the fully-drained outbox — no 10 ms polling tick involved.
        await window.ExplorerSync._outbox.flush();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('_outbox.flush() resolves immediately when the outbox is already empty', async () => {
        await setupAccepted('rugged-pine-42');
        await expect(window.ExplorerSync._outbox.flush()).resolves.toBeUndefined();
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

// ── init/flush coverage gaps (audit) ──────────────────────────────────────────
// Closes untested branches flagged by the audit: init Case 1 accepted-restore,
// Case 2/3 server non-ok early-exits, Case 4/5 switching-message cancel path,
// the window 'online' recovery handler, deleteAccount error/no-op paths, the
// scheduleFlush single-flight guard, and isLocalStorageEmpty's parse-error catch.

describe('ExplorerSync coverage gaps (audit)', () => {
    // Finding 1: init Case 1, accepted flag + no URL segment → silently restore
    // accepted state/username/token with NO network call.
    test('init: accepted flag with no URL segment restores state and username without fetching', async () => {
        setLocation('/explorer/');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
        });
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.ExplorerSync.init();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.ExplorerSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
    });

    // Finding 2a: init Case 2 (URL matches stored user) — server returns 500.
    // State is set BEFORE the fetch, so a non-ok GET must leave it 'accepted',
    // skip the merge, and not throw.
    test('init Case 2: server 500 during merge keeps accepted state and leaves local data untouched', async () => {
        setLocation('/explorer/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-1' }]),
        });
        mockFetch({ '/explorer/api/rugged-pine-42': { status: 500 } });
        loadSync();
        await expect(window.ExplorerSync.init()).resolves.toBeUndefined();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
        // merge runs only inside the res.ok branch → local row survives unchanged
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-1' }]);
    });

    // Finding 2b: init Case 3 (no flag, empty storage, URL + token) — server 500.
    // _token is set before the fetch; a non-ok GET must reset it to null, stay
    // anonymous, populate nothing, and not throw.
    test('init Case 3: server 500 during auto-load resets token, stays anonymous, populates nothing', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        vi.spyOn(window, 'confirm').mockReturnValue(true);   // consent to adopt, then fetch 500s
        mockFetch({ '/explorer/api/rugged-pine-42': { status: 500 } });
        loadSync();
        await expect(window.ExplorerSync.init()).resolves.toBeUndefined();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
        expect(localStorage.getItem('walk_visits')).toBeNull();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
    });

    // Finding 3: the window 'online' handler resets backoff and reschedules a flush.
    // Uses a unique username so only THIS instance's handler can satisfy the
    // assertion (the test harness re-runs the IIFE per loadSync(), leaving stale
    // 'online' listeners bound to other usernames on the shared window).
    test('online event triggers a flush of the pending outbox', async () => {
        await setupAccepted('windy-creek-9');
        // Stale 'online' listeners from prior loadSync() instances also fire and
        // flush the shared outbox to their own (404) paths — silence that noise.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem('walk_sync_outbox', JSON.stringify([
            { section: 'visits', op: 'put', id: 'uuid-on', data: { id: 'uuid-on' } },
        ]));
        mockFetch({ 'PUT /explorer/api/windy-creek-9/visits/uuid-on': { status: 204 } });
        window.dispatchEvent(new Event('online'));
        await flushPromises();
        const putCall = global.fetch.mock.calls.find(
            c => (c[1] && c[1].method) === 'PUT' && c[0] === '/explorer/api/windy-creek-9/visits/uuid-on'
        );
        expect(putCall).toBeTruthy();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    // Finding 4: deleteAccount rejects when the server returns non-ok, and leaves
    // the local flag/state intact (no partial teardown).
    test('deleteAccount: rejects on server 500 and does not clear local state', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({ 'DELETE /explorer/api/rugged-pine-42': { status: 500 } });
        await expect(window.ExplorerSync.deleteAccount()).rejects.toThrow();
        expect(localStorage.getItem('walk_cloud_backup')).not.toBeNull();
        expect(window.ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
    });

    // Finding 5: init Case 4/5 with a DIFFERENT stored user builds the
    // 'Switching to account X from Y' confirm message. The accept variant is
    // covered by '#1566 account switch'; this pins the message via the
    // (otherwise-untested) cancel path.
    test('init Case 4/5: switching accounts shows both usernames; cancel strips URL and loads nothing', async () => {
        setLocation('/explorer/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
        });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.ExplorerSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(confirmSpy.mock.calls[0][0]).toContain('Switching to account mossy-fern-7 from rugged-pine-42');
        // cancel: URL reset, no GET issued, local data preserved, state falls back
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/explorer/');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        expect(window.ExplorerSync.getState().state).toBe('anonymous');
    });

    // Finding 6: deleteAccount is a no-op that resolves without a request when
    // anonymous (no _username).
    test('deleteAccount: resolves without fetching when anonymous', async () => {
        setupAnonymous();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        await expect(window.ExplorerSync.deleteAccount()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    // Finding 7: two back-to-back mutations must not double-flush the first entry.
    // A never-resolving fetch keeps the first flush in-flight; the doFlush
    // _flushing guard collapses the duplicate schedule to a single request.
    test('back-to-back mutations issue only one in-flight request for the first entry', async () => {
        await setupAccepted('rugged-pine-42');
        global.fetch = vi.fn(() => new Promise(() => {})); // hangs → flush stays in-flight
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        await flushPromises();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toBe('/explorer/api/rugged-pine-42/visits/uuid-1');
    });

    // Finding 8: isLocalStorageEmpty swallows JSON.parse errors and treats a
    // corrupt section as empty (NOT as non-empty — the audit suggestion's
    // "returns false" misreads the catch). Exercised via init Case 3, which only
    // auto-loads when isLocalStorageEmpty() returns true. A throwing parse would
    // propagate out of init and reject this await.
    test('isLocalStorageEmpty treats a corrupt-JSON section as empty (catch branch) → Case 3 auto-loads', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({ walk_visits: '{ not valid json' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);   // Case 3 now consent-gated
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
