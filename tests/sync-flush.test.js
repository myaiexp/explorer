/**
 * Tests for sync-flush.js — the durable outbox and its single-flight backoff pump.
 *
 * The worker has no public surface of its own (sync.js builds it and injects an
 * authenticated apiFetch + getUsername), so it is driven here through
 * ExplorerSync.mutate / init / _outbox. Everything asserted below is the worker's
 * behaviour: queue persistence, HTTP-status handling, the backoff ladder, FIFO
 * drain, and the single-flight guard. Consent/URL state lives in sync.test.js.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, loadSync, setLocation, setLocalStorage,
    mockFetch, mockFetchOffline, drainFlushPump, flushMicrotasks, setupAccepted,
} from './helpers/sync-harness.js';

installSyncLifecycle();

// ── outbox resume on startup (audit) ──────────────────────────────────────────
// A mutation persisted to the durable outbox but not drained before the tab
// closed (queued offline, app closed; or a request mid-backoff) is otherwise only
// pumped by a fresh enqueue() or the window 'online' event — neither fires on a
// normal reload while already online. So init() must start the pump once it
// settles on an accepted account, draining a queue that survived the restart
// without waiting for the user to mutate again. Before the fix nothing did this,
// so the last session's queued walks silently never reached the cloud backup.

describe('outbox resume on startup (audit)', () => {
    test('init drains a persisted outbox for an accepted account with no further mutate', async () => {
        // Case 1: accepted flag, no URL segment (reopen at the base URL). The
        // stranded entry was written last session and must PUT on this load.
        setLocation('/wander/');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_sync_outbox: JSON.stringify([
                { section: 'visits', op: 'put', id: 'uuid-stranded', data: { id: 'uuid-stranded' } },
            ]),
        });
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-stranded': { status: 204 },
        });
        loadSync();
        await window.ExplorerSync.init();
        await drainFlushPump();
        const putCall = global.fetch.mock.calls.find(
            c => (c[1] && c[1].method) === 'PUT' && c[0] === '/wander/api/rugged-pine-42/visits/uuid-stranded'
        );
        expect(putCall).toBeTruthy();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('init does NOT flush a stray outbox when not accepted (anonymous)', async () => {
        // getUsername() gates the pump on accepted state, so a leftover queue on an
        // anonymous device must never upload — the nudge no-ops via flushHead's guard.
        setLocation('/wander/');
        setLocalStorage({
            walk_sync_outbox: JSON.stringify([
                { section: 'visits', op: 'put', id: 'uuid-x', data: { id: 'uuid-x' } },
            ]),
        });
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.ExplorerSync.init();
        await drainFlushPump();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
    });
});

// ── enqueue → flush ───────────────────────────────────────────────────────────

describe('outbox enqueue and per-status handling', () => {
    test('enqueues PUT when accepted and clears outbox on 204', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-1': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await drainFlushPump();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('outbox persists to localStorage before flush resolves', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetchOffline();
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        // Synchronous check — outbox is written before async flush fires
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
    });

    test('does not schedule flush when the outbox write returns false (audit #5721)', async () => {
        // Hard-quota: writeStoredArray already toasted; enqueue must not arm the
        // pump against a queue that never accepted the entry — otherwise flush
        // races a durable write that never happened (and can drop the mutation).
        await setupAccepted('rugged-pine-42');
        const realWrite = globalThis.writeStoredArray;
        globalThis.writeStoredArray = (key, arr) => {
            if (key === 'walk_sync_outbox') return false;
            return realWrite(key, arr);
        };
        try {
            const fetchSpy = vi.fn();
            global.fetch = fetchSpy;

            window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
            await drainFlushPump();

            expect(fetchSpy).not.toHaveBeenCalled();
            // Prior durable state is unchanged — the failed write left nothing new.
            expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
        } finally {
            // Direct assignment (not a vi.spy) — restore so later tests don't
            // inherit a permanently-failing outbox writer.
            globalThis.writeStoredArray = realWrite;
        }
    });

    // HTTP 204, then saveOutbox(remaining) fails: the processed head is still
    // on disk. Back off (nextBackoff from 0 → 1000ms) rather than
    // scheduleFlush(0) — a tight retry would re-PUT the same entry forever
    // until the tab OOMs (finding #7924).
    test('successful 204 then failed outbox shift backs off instead of tight-looping (finding #7924)', async () => {
        vi.useFakeTimers();
        await setupAccepted('rugged-pine-42');

        const realWrite = globalThis.writeStoredArray;
        globalThis.writeStoredArray = (key, arr) => {
            if (key === 'walk_sync_outbox') {
                const current = JSON.parse(localStorage.getItem(key) || '[]');
                if (arr.length < current.length) return false;
            }
            return realWrite(key, arr);
        };
        try {
            let callCount = 0;
            global.fetch = vi.fn(() => {
                callCount++;
                return Promise.resolve({
                    ok: true, status: 204,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                });
            });

            window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
            await flushMicrotasks();

            expect(callCount).toBe(1);
            expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

            // scheduleFlush(0) after the failed shift would have already fired a
            // second PUT during flushMicrotasks. The pump must wait for the
            // first backoff step instead.
            await vi.advanceTimersByTimeAsync(999);
            expect(callCount).toBe(1);

            await vi.advanceTimersByTimeAsync(1);
            await flushMicrotasks();

            expect(callCount).toBe(2);
            expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
        } finally {
            globalThis.writeStoredArray = realWrite;
        }
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
        await flushMicrotasks();

        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(11000);
        await flushMicrotasks();

        expect(callCount).toBe(2);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
    });

    test('drops entry on entry-level 4xx (400, not 429) and warns', async () => {
        await setupAccepted('rugged-pine-42');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-bad': { status: 400 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-bad', { id: 'uuid-bad' });
        await drainFlushPump();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
    });
});

// ── #1567 — outbox flush: DELETE op, 5xx backoff, multi-entry drain ────────────

describe('#1567 outbox flush DELETE / backoff / drain', () => {
    test('delete op sends DELETE with no body and clears entry on 204', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'DELETE /wander/api/rugged-pine-42/visits/uuid-del': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'delete', 'uuid-del', undefined);
        await drainFlushPump();

        const deleteCall = global.fetch.mock.calls.find(c => (c[1] && c[1].method) === 'DELETE');
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[0]).toBe('/wander/api/rugged-pine-42/visits/uuid-del');
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
        await flushMicrotasks();

        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

        // BACKOFF_STEPS[0] is exactly 1000ms — retry must NOT fire before then.
        // Mutating the first backoff step (e.g. 1000 → 500) makes this RED.
        await vi.advanceTimersByTimeAsync(999);
        expect(callCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(callCount).toBe(2);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
    });

    // apiFetch rejection (network down, fetchWithTimeout AbortError) must
    // clear _flushing and arm the 1s backoff. If .catch left _flushing true,
    // the timer's flushHead would no-op and freeze the durable queue
    // (finding #7923). net.js exists so a hung request becomes this reject.
    test('fetch AbortError clears _flushing and retries after 1s backoff (finding #7923)', async () => {
        vi.useFakeTimers();
        await setupAccepted('rugged-pine-42');

        let callCount = 0;
        global.fetch = vi.fn(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.reject(
                    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
                );
            }
            return Promise.resolve({
                ok: true, status: 204,
                headers: new Headers(),
                json: () => Promise.resolve({}),
            });
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await flushMicrotasks();

        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(callCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(callCount).toBe(2);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toHaveLength(0);
    });

    test('consecutive 5xx escalate the backoff ladder (1000ms → 2000ms), not a constant 1s', async () => {
        vi.useFakeTimers();
        await setupAccepted('rugged-pine-42');

        // Server is persistently down — every attempt 500s.
        let callCount = 0;
        global.fetch = vi.fn(() => {
            callCount++;
            return Promise.resolve({
                ok: false, status: 500,
                headers: new Headers(),
                json: () => Promise.resolve({}),
            });
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await flushMicrotasks();
        expect(callCount).toBe(1);

        // BACKOFF_STEPS[0] = 1000ms — the second attempt waits exactly that long.
        await vi.advanceTimersByTimeAsync(999);
        expect(callCount).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(callCount).toBe(2);

        // The second 5xx must ESCALATE to BACKOFF_STEPS[1] = 2000ms. Under the
        // reset bug (_backoffMs zeroed at the top of .then) the ladder stayed at
        // 1000ms, so a third attempt would fire here at +1000ms — assert it does
        // NOT, and only fires at +2000ms.
        await vi.advanceTimersByTimeAsync(1000);
        expect(callCount).toBe(2);   // RED under the bug: would already be 3
        await vi.advanceTimersByTimeAsync(999);
        expect(callCount).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(callCount).toBe(3);
    });

    test('two queued entries drain in order via post-flush reschedule', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-1': { status: 204 },
            'PUT /wander/api/rugged-pine-42/visits/uuid-2': { status: 204 },
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        // Both enqueued synchronously before the async flush drains either
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(2);

        await drainFlushPump();

        const putUrls = global.fetch.mock.calls
            .filter(c => (c[1] && c[1].method) === 'PUT')
            .map(c => c[0]);
        // FIFO order proves the post-success scheduleFlush(0) reschedule fired for entry 2
        expect(putUrls).toEqual([
            '/wander/api/rugged-pine-42/visits/uuid-1',
            '/wander/api/rugged-pine-42/visits/uuid-2',
        ]);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('_outbox.whenDrained() resolves once the queue drains (event-based, not polled)', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-1': { status: 204 },
            'PUT /wander/api/rugged-pine-42/visits/uuid-2': { status: 204 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(2);
        // Awaiting the returned promise must resolve when settleFlushWaiters fires
        // on the fully-drained outbox — no 10 ms polling tick involved.
        await window.ExplorerSync._outbox.whenDrained();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    test('_outbox.whenDrained() resolves immediately when the outbox is already empty', async () => {
        await setupAccepted('rugged-pine-42');
        await expect(window.ExplorerSync._outbox.whenDrained()).resolves.toBeUndefined();
    });
});

// ── recovery + single-flight ──────────────────────────────────────────────────

describe('flush pump recovery and single-flight guard', () => {
    // The window 'online' handler resets backoff and reschedules a flush. Each
    // loadSync() retires the previous instance (ExplorerSync._destroy → the
    // worker's destroy()), so exactly one live handler exists here — before that
    // fix, ~90 stale workers also answered this event and raced on the shared
    // outbox key (audit #5399).
    test('online event triggers a flush of the pending outbox', async () => {
        await setupAccepted('rugged-pine-42');
        localStorage.setItem('walk_sync_outbox', JSON.stringify([
            { section: 'visits', op: 'put', id: 'uuid-on', data: { id: 'uuid-on' } },
        ]));
        mockFetch({ 'PUT /wander/api/rugged-pine-42/visits/uuid-on': { status: 204 } });
        window.dispatchEvent(new Event('online'));
        await drainFlushPump();
        // Exactly one PUT — a leaked listener from an earlier loadSync() would add
        // its own request for the same entry against a stale username.
        const putCalls = global.fetch.mock.calls.filter(c => (c[1] && c[1].method) === 'PUT');
        expect(putCalls).toHaveLength(1);
        expect(putCalls[0][0]).toBe('/wander/api/rugged-pine-42/visits/uuid-on');
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
    });

    // A retired instance must be fully inert: its 'online' listener is detached
    // and its worker refuses to schedule, so nothing can touch the shared outbox
    // after the next loadSync() replaces it.
    test('a retired instance ignores online events and leaves the outbox alone', async () => {
        await setupAccepted('rugged-pine-42');
        const stale = window.ExplorerSync;
        localStorage.setItem('walk_sync_outbox', JSON.stringify([
            { section: 'visits', op: 'put', id: 'uuid-stale', data: { id: 'uuid-stale' } },
        ]));
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;

        stale._destroy();
        window.dispatchEvent(new Event('online'));
        await stale._outbox.whenDrained();          // resolves rather than hanging
        await drainFlushPump();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
    });

    // Two back-to-back mutations must not double-flush the first entry. A
    // never-resolving fetch keeps the first flush in-flight; the flushHead
    // _flushing guard collapses the duplicate schedule to a single request.
    test('back-to-back mutations issue only one in-flight request for the first entry', async () => {
        await setupAccepted('rugged-pine-42');
        global.fetch = vi.fn(() => new Promise(() => {})); // hangs → flush stays in-flight
        window.ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-2', { id: 'uuid-2' });
        await drainFlushPump();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toBe('/wander/api/rugged-pine-42/visits/uuid-1');
    });
});

// ── request-path encoding (audit) ─────────────────────────────────────────────
// An outbox entry's id is not always one we minted: importVisits takes ids
// verbatim from an uploaded backup file, so an id can carry a '/' or a dot
// segment. Concatenated into the path (the old code), the browser normalizes it
// away BEFORE the request goes out and the authenticated PUT lands on a
// different endpoint entirely. apiFetch now takes segments and encodes each.

describe('request path encoding', () => {
    test('a traversal-shaped outbox id cannot redirect the authenticated write', async () => {
        await setupAccepted('rugged-pine-42');
        // Pre-fix path: /wander/api/rugged-pine-42/visits/../../accounts
        // → normalized by fetch to /wander/api/accounts, with the Bearer token.
        localStorage.setItem('walk_sync_outbox', JSON.stringify([
            { section: 'visits', op: 'put', id: '../../accounts', data: { id: 'x' } },
        ]));
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true, status: 204, headers: new Headers(), json: () => Promise.resolve({}),
        }));
        window.dispatchEvent(new Event('online'));
        await drainFlushPump();

        const url = global.fetch.mock.calls[0][0];
        expect(url).toBe('/wander/api/rugged-pine-42/visits/..%2F..%2Faccounts');
        // The decisive property: whatever it targets, it stays under the section.
        expect(new URL(url, 'https://mase.fi').pathname)
            .toBe('/wander/api/rugged-pine-42/visits/..%2F..%2Faccounts');
    });

    test('section and username segments are encoded too', async () => {
        await setupAccepted('rugged-pine-42');
        localStorage.setItem('walk_sync_outbox', JSON.stringify([
            { section: 'visits/../favorites', op: 'delete', id: 'uuid-1' },
        ]));
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true, status: 204, headers: new Headers(), json: () => Promise.resolve({}),
        }));
        window.dispatchEvent(new Event('online'));
        await drainFlushPump();
        expect(global.fetch.mock.calls[0][0])
            .toBe('/wander/api/rugged-pine-42/visits%2F..%2Ffavorites/uuid-1');
    });

    test('ordinary uuids and usernames are untouched by the encoding', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({ 'PUT /wander/api/rugged-pine-42/visits/uuid-plain': { status: 204 } });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-plain', { id: 'uuid-plain' });
        await drainFlushPump();
        expect(global.fetch.mock.calls[0][0]).toBe('/wander/api/rugged-pine-42/visits/uuid-plain');
    });
});
