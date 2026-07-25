/**
 * Shared bootstrap for the cloud-backup test files — sync.test.js (consent/URL
 * state machine), sync-flush.test.js (durable outbox + backoff pump), and
 * sync-sections.test.js (merge/normalize/wipe of the four synced sections).
 *
 * The three source modules are non-module IIFEs that register globals, so every
 * suite that drives ExplorerSync needs the same realm setup: run the scripts in
 * the jsdom global context, seed location + localStorage, stub fetch. That setup
 * lives here so each suite's bootstrap is `installSyncLifecycle()` plus whatever
 * it actually asserts.
 *
 * Note: security-hook warning acknowledged — new Function() is intentional here.
 * The sources are static local assets, not user input.
 */

import { beforeEach, afterEach, vi } from 'vitest';
// sync.js's IIFE reads globalThis.createSyncFlushWorker (sync-flush.js) and
// globalThis.SyncSections (sync-sections.js) at load time, so both sibling
// modules must run first — mirrors index.html's script order.
import FLUSH_SRC from '../../sync-flush.js?raw';
import SECTIONS_SRC from '../../sync-sections.js?raw';
import SYNC_SRC from '../../sync.js?raw';
// Side-effect import: storage.js owns the walk_* key strings and readStoredArray
// that sync-sections.js resolves off globalThis at call time. Importing it runs
// its top-level globalThis assignments once, so those globals exist before any
// ExplorerSync method runs (mirrors prod, where both scripts have executed by the
// time init() is called). Values are constant, so a single load suffices.
import '../../storage.js';
// Side-effect import: net.js registers globalThis.fetchWithTimeout, which
// sync.js's apiFetch calls. Load it before loadSync() runs the IIFE.
import '../../net.js';

// ── Loading the sync scripts ─────────────────────────────────────────────────

/**
 * Retire the currently-loaded ExplorerSync instance, if any.
 *
 * sync.js binds a window 'online' listener and owns a flush worker with its own
 * backoff timer. Both outlive the instance unless explicitly detached, and every
 * instance reads and shifts the SAME walk_sync_outbox localStorage key — so
 * without this, a file that calls loadSync() ~90 times ends with ~90 live workers
 * flushing one shared queue to their own stale usernames (audit #5399).
 */
export function destroySync() {
    if (window.ExplorerSync && typeof window.ExplorerSync._destroy === 'function') {
        window.ExplorerSync._destroy();
    }
}

/**
 * Execute the three IIFEs in the jsdom global scope, replacing any previous
 * instance. Order matches index.html: the flush worker + section helpers
 * register their globals before sync.js's IIFE consumes them.
 */
export function loadSync() {
    destroySync();
    delete window.ExplorerSync;
    // new Function with static local file content — not user-supplied input
    new Function(FLUSH_SRC).call(window);    // eslint-disable-line no-new-func
    new Function(SECTIONS_SRC).call(window); // eslint-disable-line no-new-func
    new Function(SYNC_SRC).call(window);     // eslint-disable-line no-new-func
}

/** Register the per-test lifecycle every sync suite shares. */
export function installSyncLifecycle() {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        delete window.ExplorerSyncUI;
        setLocation('/explorer/');
        loadSync();
    });

    afterEach(() => {
        // Retire the last instance too, so a backoff timer armed by the final test
        // can't fire into the next file's realm.
        destroySync();
        vi.clearAllTimers();
        vi.useRealTimers();
    });
}

// ── Environment seeding ──────────────────────────────────────────────────────

export function setLocation(pathname, hash) {
    Object.defineProperty(window, 'location', {
        value: { pathname, hash: hash || '', origin: 'https://mase.fi', assign: vi.fn() },
        writable: true,
        configurable: true,
    });
}

export function setLocalStorage(obj) {
    localStorage.clear();
    Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, v));
}

// ── fetch stubs ──────────────────────────────────────────────────────────────

/**
 * Build a mock fetch keyed by "METHOD url" or bare url for GET.
 * Value: body object (status defaults 200) or { status, headers?, ...body }.
 * Special value 'OFFLINE' → network rejection.
 */
export function mockFetch(routes) {
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

export function mockFetchOffline() {
    global.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
}

// ── Draining ─────────────────────────────────────────────────────────────────

// Drain the async pipeline so assertions run after sync.js has fully settled.
// The flush pump handles one entry per setTimeout(0) "tick" — each successful
// upsert reschedules the next via scheduleFlush(0) — so a fixed handful of awaits
// is fragile: adding an async hop (or draining one more entry) could let a test
// resolve before the flush completes and pass vacuously. Instead we yield a
// generous, bounded number of real-timer macrotask turns; each turn fires one
// pending setTimeout(0) and drains all microtasks around it, advancing the
// reschedule chain by exactly one hop. FLUSH_TURNS is far above any realistic
// chain depth (current max ~2 hops), so the helper stays correct as the pipeline
// grows.
// Safe only under real timers — every caller runs without fake timers (the
// fake-timer tests drive the clock explicitly via advanceTimersByTimeAsync).
const FLUSH_TURNS = 20;
export async function flushPromises() {
    for (let i = 0; i < FLUSH_TURNS; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

// ── Common starting states ───────────────────────────────────────────────────

export function setupAnonymous() {
    setLocation('/explorer/');
    setLocalStorage({});
    loadSync();
}

export async function setupAccepted(username) {
    setLocation('/explorer/' + username);
    setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username, token: 'tok-' + username }) });
    mockFetch({
        ['/explorer/api/' + username]: { visits: [], favorites: [], savedLocations: [], history: [] },
    });
    loadSync();
    await window.ExplorerSync.init();
    global.fetch = vi.fn();
}
