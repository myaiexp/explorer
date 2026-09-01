/**
 * Tests for sync-flush.js auth hard-stop (401/403) — audit #6223.
 *
 * Entry-level 4xx (400) still drops the head; 401/403 must keep the durable
 * queue, toast once, and freeze the pump until init rebinds and resume()s.
 * Sibling of sync-flush.test.js (enqueue / backoff / drain / path encoding).
 */

import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, mockFetch, drainFlushPump, setupAccepted,
} from './helpers/sync-harness.js';

installSyncLifecycle();

describe('auth hard-stop (audit #6223)', () => {
    test('401 keeps the outbox head, toasts once, and freezes further flush', async () => {
        await setupAccepted('rugged-pine-42');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errors = [];
        globalThis.showError = (msg) => { errors.push(msg); };

        let callCount = 0;
        global.fetch = vi.fn(() => {
            callCount++;
            return Promise.resolve({
                ok: false, status: 401,
                headers: new Headers(),
                json: () => Promise.resolve({ error: 'Unauthorized' }),
            });
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-a', { id: 'uuid-a' });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-b', { id: 'uuid-b' });
        await drainFlushPump();

        // Only the head was attempted; both entries remain queued.
        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(2);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/authorization failed/i);
        expect(warnSpy).toHaveBeenCalled();

        // A later enqueue must not re-arm the pump while auth is still broken.
        window.ExplorerSync.mutate('visits', 'put', 'uuid-c', { id: 'uuid-c' });
        await drainFlushPump();
        expect(callCount).toBe(1);
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(3);
        // Still a single toast — not one per enqueue.
        expect(errors).toHaveLength(1);

        delete globalThis.showError;
    });

    test('403 hard-stops like 401 (keeps queue, no drain)', async () => {
        await setupAccepted('rugged-pine-42');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errors = [];
        globalThis.showError = (msg) => { errors.push(msg); };
        mockFetch({
            'PUT /wander/api/rugged-pine-42/visits/uuid-f': { status: 403 },
        });
        window.ExplorerSync.mutate('visits', 'put', 'uuid-f', { id: 'uuid-f' });
        await drainFlushPump();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
        expect(errors).toHaveLength(1);
        delete globalThis.showError;
    });

    test('re-init after 401 resumes the pump and drains the preserved queue', async () => {
        await setupAccepted('rugged-pine-42');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.showError = () => {};

        let putAttempts = 0;
        global.fetch = vi.fn((url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            // First PUT: 401. Re-init GET + resumed PUT: ok.
            if (method === 'PUT') {
                putAttempts++;
                if (putAttempts === 1) {
                    return Promise.resolve({
                        ok: false, status: 401,
                        headers: new Headers(),
                        json: () => Promise.resolve({}),
                    });
                }
                return Promise.resolve({
                    ok: true, status: 204,
                    headers: new Headers(),
                    json: () => Promise.resolve({}),
                });
            }
            return Promise.resolve({
                ok: true, status: 200,
                headers: new Headers(),
                json: () => Promise.resolve({
                    visits: [], favorites: [], savedLocations: [], history: [],
                }),
            });
        });

        window.ExplorerSync.mutate('visits', 'put', 'uuid-resume', { id: 'uuid-resume' });
        await drainFlushPump();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
        expect(putAttempts).toBe(1);

        // Rebind: init on accepted consent calls resume() and re-arms flush.
        await window.ExplorerSync.init();
        await drainFlushPump();
        expect(JSON.parse(localStorage.getItem('walk_sync_outbox') || '[]')).toEqual([]);
        expect(putAttempts).toBe(2);

        delete globalThis.showError;
    });
});
