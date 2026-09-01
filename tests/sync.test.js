/**
 * Tests for sync.js — the consent/URL state machine and public API.
 *
 * Scope: init's five cases, accept/decline/deleteAccount/requestConsent, and
 * mutate's accepted-state gate. The two sibling modules sync.js composes have
 * their own suites — sync-flush.test.js (durable outbox + backoff pump) and
 * sync-sections.test.js (merge/normalize/wipe) — so a change to either has one
 * obvious place to look. Realm bootstrap lives in helpers/sync-harness.js.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    installSyncLifecycle, loadSync, setLocation, setLocalStorage,
    mockFetch, drainFlushPump, setupAnonymous, setupAccepted, serverTrip,
} from './helpers/sync-harness.js';
installSyncLifecycle();

// ── WanderSync.init ─────────────────────────────────────────────────────────

describe('WanderSync.init', () => {
    test('anonymous when no flag and no URL segment', async () => {
        setLocation('/wander/');
        setLocalStorage({});
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState().state).toBe('anonymous');
    });

    test('accepted when flag matches URL segment and merges server data', async () => {
        setLocation('/wander/rugged-pine-42');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }) });
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
    });

    test('URL segment + token fragment with empty localStorage loads after consent', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': {
                visits: [serverTrip({ updatedAt: '2024-01-01T00:00:00Z' })],
                favorites: [], savedLocations: [], history: [],
            },
        });
        // Adopting a URL-sourced account binds this browser to it, so it requires
        // explicit consent even on an empty device (shared-link hijack guard).
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        loadSync();
        await window.WanderSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(confirmSpy.mock.calls[0][0]).toContain('Load shared backup account rugged-pine-42');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toHaveLength(1);
        expect(window.WanderSync.getState().state).toBe('accepted');
        // The token from the fragment is captured and persisted to the record.
        expect(window.WanderSync.getState().token).toBe('tok-rp42');
        expect(JSON.parse(localStorage.getItem('walk_cloud_backup')).token).toBe('tok-rp42');
    });

    test('URL segment + token on a fresh device: declining consent stays anonymous and uploads nothing', async () => {
        // Security regression (audit): opening someone else's shared link must not
        // silently bind a fresh browser to their account. Declining the prompt
        // issues no request, strips the URL, and leaves the browser anonymous so
        // no future mutation can sync to the link owner's account.
        setLocation('/wander/evil-acct-1', '#t=tok-evil');
        setLocalStorage({});
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.WanderSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/');
        expect(window.WanderSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
        expect(localStorage.getItem('walk_visits')).toBeNull();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
    });

    test('URL segment WITHOUT token fragment on a fresh device does NOT auto-load', async () => {
        // No flag, empty localStorage, bare link (no #t=) → no credential, so the
        // app cannot fetch the account. It must stay anonymous and issue no request.
        setLocation('/wander/rugged-pine-42');
        setLocalStorage({});
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.WanderSync.init();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.WanderSync.getState().state).toBe('anonymous');
        expect(localStorage.getItem('walk_visits')).toBeNull();
    });

    test('malformed percent-encoded token fragment does not throw; falls through to no-token path', async () => {
        // #t=% / #t=%ZZ throw URIError from decodeURIComponent unless caught —
        // that used to abort WanderSync.init and skip first paint (finding #6222).
        setLocation('/wander/rugged-pine-42', '#t=%');
        setLocalStorage({});
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await expect(window.WanderSync.init()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.WanderSync.getState().state).toBe('anonymous');
        expect(window.WanderSync.getState().token).toBeNull();
    });

    test('corrupt walk_cloud_backup JSON stays anonymous without throwing or fetching', async () => {
        // Truncated or hand-edited consent blob: JSON.parse throws, readConsentRecord
        // returns null, and init treats the device as anonymous (finding #7927).
        // settings.test.js / storage.test.js pin the same '{not json' shape for
        // their keys; without this, a parse throw here would skip first paint.
        setLocation('/wander/');
        setLocalStorage({ walk_cloud_backup: '{not json' });
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await expect(window.WanderSync.init()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'anonymous', username: null, token: null,
        });
    });

    test('URL segment with non-empty localStorage prompts confirm; cancel strips URL', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({ walk_visits: '[{"id":"old"}]' });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        loadSync();
        await window.WanderSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/');
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'old' }]);
        expect(window.WanderSync.getState().state).toBe('anonymous');
    });

    test('URL segment with non-empty localStorage prompts confirm; accept loads server data', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({ walk_visits: '[{"id":"old"}]' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({
            '/wander/api/rugged-pine-42': {
                visits: [serverTrip({ id: 'server-1' })], favorites: [], savedLocations: [], history: [],
            },
        });
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState().state).toBe('accepted');
        expect(JSON.parse(localStorage.getItem('walk_visits')).map((v) => v.id)).toEqual(['server-1']);
    });

    test('declined flag with no URL segment stays declined', async () => {
        setLocation('/wander/');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'declined' }) });
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState().state).toBe('declined');
    });

    // init Case 1: accepted flag + no URL segment → silently restore
    // accepted state/username/token with NO network call.
    test('accepted flag with no URL segment restores state and username without fetching', async () => {
        setLocation('/wander/');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
        });
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.WanderSync.init();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
    });

    // init Case 2 (URL matches stored user) — server returns 500. State is set
    // BEFORE the fetch, so a non-ok GET must leave it 'accepted', skip the merge,
    // and not throw.
    test('Case 2: server 500 during merge keeps accepted state and leaves local data untouched', async () => {
        setLocation('/wander/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-1' }]),
        });
        mockFetch({ '/wander/api/rugged-pine-42': { status: 500 } });
        loadSync();
        await expect(window.WanderSync.init()).resolves.toBeUndefined();
        expect(window.WanderSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
        // merge runs only inside the res.ok branch → local row survives unchanged
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-1' }]);
    });

    // init Case 3 (no flag, empty storage, URL + token) — server 500. _token is
    // set before the fetch; a non-ok GET must reset it to null, stay anonymous,
    // populate nothing, and not throw.
    test('Case 3: server 500 during auto-load resets token, stays anonymous, populates nothing', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        vi.spyOn(window, 'confirm').mockReturnValue(true);   // consent to adopt, then fetch 500s
        mockFetch({ '/wander/api/rugged-pine-42': { status: 500 } });
        loadSync();
        await expect(window.WanderSync.init()).resolves.toBeUndefined();
        expect(window.WanderSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
        expect(localStorage.getItem('walk_visits')).toBeNull();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
    });

    // init Case 4/5 with a DIFFERENT stored user builds the 'Switching to account
    // X from Y' confirm message. The accept variant is covered by the account-switch
    // wipe test in sync-sections.test.js; this pins the message via the
    // (otherwise-untested) cancel path.
    test('Case 4/5: switching accounts shows both usernames; cancel strips URL and loads nothing', async () => {
        setLocation('/wander/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
        });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        loadSync();
        await window.WanderSync.init();
        expect(confirmSpy).toHaveBeenCalled();
        expect(confirmSpy.mock.calls[0][0]).toContain('Switching to account mossy-fern-7 from rugged-pine-42');
        // cancel: URL reset, no GET issued, local data preserved
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{ id: 'local-v' }]);
        // …and the device stays bound to the account it already owned. Dropping to
        // 'anonymous' here (audit #5426) desynced the session from localStorage,
        // which still said accepted/rugged-pine-42.
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
    });

    // The user-visible consequence of that state drop: mutate() gates on
    // _state === 'accepted', so a cancelled switch used to silently stop backing
    // up the account the device still owns — for the rest of the session, with no
    // UI signal. Pins the behaviour, not just the state fields.
    test('Case 4/5 cancel: the still-bound account keeps queueing mutations', async () => {
        setLocation('/wander/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' }),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        mockFetch({});
        loadSync();
        await window.WanderSync.init();
        window.WanderSync.mutate('visits', 'upsert', 'v1', { id: 'v1' });
        // Synchronous assertion: enqueue schedules the flush on a microtask, so
        // the entry is still queued here regardless of what the pump does next.
        expect(window.WanderSync.getState().outboxLength).toBe(1);
    });

    // Same rule for a device whose stored decision is 'declined': cancelling a
    // link-sourced switch must leave it declined, not silently anonymous (which
    // would let maybeRequestConsent re-prompt someone who already said no).
    test('Case 4/5 cancel with a declined record stays declined', async () => {
        setLocation('/wander/mossy-fern-7', '#t=tok-mf7');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'declined' }),
            walk_visits: JSON.stringify([{ id: 'local-v' }]),
        });
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'declined', username: null, token: null,
        });
    });
});

// ── restored backup invisible until reload (audit) ────────────────────────────
// init Case 2's own-device merge rewrites localStorage but historically fired no
// wander-sync-state-change event, so app.js never re-rendered the merged rows —
// a restored backup stayed invisible until a manual reload. The merge path now
// fires the event on success (via loadAccount's onSuccess = fireStateChange) so
// the app.js refreshDataViews hook runs; a failed GET must NOT fire it.

describe('init Case 2 merge fires state-change so the UI re-renders', () => {
    function setupCase2(fetchConfig) {
        setLocation('/wander/rugged-pine-42');
        setLocalStorage({
            walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }),
        });
        mockFetch({ '/wander/api/rugged-pine-42': fetchConfig });
    }

    test('own-device merge dispatches wander-sync-state-change on success', async () => {
        setupCase2({
            visits: [serverTrip({ id: 'server-1', updatedAt: '2024-06-01T00:00:00Z' })],
            favorites: [], savedLocations: [], history: [],
        });
        const eventSpy = vi.fn();
        window.addEventListener('wander-sync-state-change', eventSpy);
        loadSync();
        await window.WanderSync.init();
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('wander-sync-state-change', eventSpy);
    });

    test('a failed merge GET does NOT fire state-change (fires only on success)', async () => {
        setupCase2({ status: 500 });
        const eventSpy = vi.fn();
        window.addEventListener('wander-sync-state-change', eventSpy);
        loadSync();
        await window.WanderSync.init();
        expect(eventSpy).not.toHaveBeenCalled();
        window.removeEventListener('wander-sync-state-change', eventSpy);
    });
});

// ── WanderSync.mutate — the accepted-state gate ─────────────────────────────
// mutate's only job in this module is the gate; everything past it belongs to the
// flush worker and is covered in sync-flush.test.js.

describe('WanderSync.mutate gating', () => {
    test('no-op when anonymous', async () => {
        setupAnonymous();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        window.WanderSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await drainFlushPump();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(localStorage.getItem('walk_sync_outbox')).toBeNull();
    });

    test('no-op when declined', async () => {
        setLocation('/wander/');
        setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'declined' }) });
        loadSync();
        await window.WanderSync.init();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        window.WanderSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1' });
        await drainFlushPump();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// ── WanderSync.accept ───────────────────────────────────────────────────────

describe('WanderSync.accept', () => {
    test('generates UUID for legacy saved_locations missing id', async () => {
        setLocation('/wander/');
        setLocalStorage({ walk_saved_locations: JSON.stringify([{ label: 'home', value: 'Home St 1' }]) });
        mockFetch({
            'POST /wander/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /wander/api/rugged-pine-42/import': { status: 204 },
        });
        loadSync();
        await window.WanderSync.accept();
        const stored = JSON.parse(localStorage.getItem('walk_saved_locations'));
        expect(stored[0]).toHaveProperty('id');
        expect(stored[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('rewrites URL and fires state-change event on success', async () => {
        setLocation('/wander/');
        setLocalStorage({});
        mockFetch({
            'POST /wander/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /wander/api/rugged-pine-42/import': { status: 204 },
        });
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const eventSpy = vi.fn();
        window.addEventListener('wander-sync-state-change', eventSpy);
        loadSync();
        await window.WanderSync.accept();
        // The secret token rides in the URL fragment so the link itself is the credential.
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/rugged-pine-42#t=tok-rp42');
        expect(window.WanderSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42' });
        expect(window.WanderSync.getState().link).toBe('https://mase.fi/wander/rugged-pine-42#t=tok-rp42');
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('wander-sync-state-change', eventSpy);
    });

    test('does not write flag if import POST fails', async () => {
        setLocation('/wander/');
        setLocalStorage({});
        mockFetch({
            'POST /wander/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /wander/api/rugged-pine-42/import': { status: 500 },
        });
        loadSync();
        await expect(window.WanderSync.accept()).rejects.toThrow();
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
        expect(window.WanderSync.getState().state).toBe('anonymous');
    });
});

// ── WanderSync.decline ─────────────────────────────────────────────────────

describe('WanderSync.decline', () => {
    test('sets declined flag and fires state-change event', () => {
        setLocation('/wander/');
        setLocalStorage({});
        loadSync();
        const eventSpy = vi.fn();
        window.addEventListener('wander-sync-state-change', eventSpy);
        window.WanderSync.decline();
        expect(window.WanderSync.getState().state).toBe('declined');
        expect(JSON.parse(localStorage.getItem('walk_cloud_backup'))).toEqual({ state: 'declined' });
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('wander-sync-state-change', eventSpy);
    });
});

// ── WanderSync.deleteAccount ───────────────────────────────────────────────

describe('WanderSync.deleteAccount', () => {
    test('clears flag, outbox, strips URL, fires state-change', async () => {
        await setupAccepted('rugged-pine-42');
        localStorage.setItem('walk_sync_outbox', JSON.stringify([{ section: 'visits', op: 'put', id: 'x' }]));
        mockFetch({
            'DELETE /wander/api/rugged-pine-42': { status: 204 },
        });
        const replaceSpy = vi.spyOn(history, 'replaceState');
        const eventSpy = vi.fn();
        window.addEventListener('wander-sync-state-change', eventSpy);
        await window.WanderSync.deleteAccount();
        expect(window.WanderSync.getState()).toMatchObject({ state: 'anonymous', username: null, token: null });
        expect(localStorage.getItem('walk_cloud_backup')).toBeNull();
        expect(localStorage.getItem('walk_sync_outbox')).toBeNull();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/');
        expect(eventSpy).toHaveBeenCalled();
        window.removeEventListener('wander-sync-state-change', eventSpy);
    });

    test('rejects on server 500 and does not clear local state', async () => {
        await setupAccepted('rugged-pine-42');
        mockFetch({ 'DELETE /wander/api/rugged-pine-42': { status: 500 } });
        await expect(window.WanderSync.deleteAccount()).rejects.toThrow();
        expect(localStorage.getItem('walk_cloud_backup')).not.toBeNull();
        expect(window.WanderSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
    });

    test('resolves without fetching when anonymous', async () => {
        setupAnonymous();
        const fetchSpy = vi.fn();
        global.fetch = fetchSpy;
        await expect(window.WanderSync.deleteAccount()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// ── WanderSync.requestConsent ──────────────────────────────────────────────

describe('WanderSync.requestConsent', () => {
    test('falls back to window.confirm when no WanderSyncUI hook', async () => {
        setLocation('/wander/');
        setLocalStorage({});
        mockFetch({
            'POST /wander/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /wander/api/rugged-pine-42/import': { status: 204 },
        });
        loadSync();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const result = await window.WanderSync.requestConsent();
        expect(result).toBe('accepted');
    });

    test('uses WanderSyncUI.showConsentToast when registered', async () => {
        setLocation('/wander/');
        setLocalStorage({});
        loadSync();
        window.WanderSyncUI = {
            showConsentToast: vi.fn(() => Promise.resolve('declined')),
        };
        const result = await window.WanderSync.requestConsent();
        expect(window.WanderSyncUI.showConsentToast).toHaveBeenCalled();
        expect(result).toBe('declined');
    });
});

// ── The dual-URL policy ──────────────────────────────────────────────────────

// The app was renamed explorer → wander, and /explorer stays live permanently:
// a cloud-backup bearer travels between devices as /explorer/<username>#t=<token>,
// so a link handed out before the rename has to keep working forever. The rule
// is read either prefix, write only /wander/ — these pin both halves.
describe('legacy /explorer URLs', () => {
    test('an old /explorer account link is still read as an account', async () => {
        // This is how a bearer token reaches a device that has not loaded since
        // the rename. Stop reading the old prefix and the link is a dead 404
        // with no way to recover the account.
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
    });

    test('a /wander account link is read as an account', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        loadSync();
        await window.WanderSync.init();
        expect(window.WanderSync.getState()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
    });

    test('the address bar is canonicalised to /wander on arrival from /explorer', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        loadSync();
        await window.WanderSync.init();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/rugged-pine-42#t=tok-rp42');
    });

    test('canonicalising rewrites the path only — the hash keeps the token AND any share-link route', async () => {
        // The fragment is not just the credential: share-link.js encodes the
        // whole route into it. Rebuilding the hash from the token alone would
        // destroy a shared route the moment the page loaded.
        setLocation('/explorer/rugged-pine-42', '#r=abc123&t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        loadSync();
        await window.WanderSync.init();
        expect(replaceSpy).toHaveBeenCalledWith(null, '', '/wander/rugged-pine-42#r=abc123&t=tok-rp42');
    });

    test('a /wander arrival is not rewritten', async () => {
        setLocation('/wander/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const replaceSpy = vi.spyOn(history, 'replaceState');
        loadSync();
        await window.WanderSync.init();
        expect(replaceSpy).not.toHaveBeenCalled();
    });

    test('a shareable account link is always built on /wander', async () => {
        setLocation('/explorer/rugged-pine-42', '#t=tok-rp42');
        setLocalStorage({});
        mockFetch({
            '/wander/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] },
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        loadSync();
        await window.WanderSync.init();
        // Arrived on the old prefix; the link handed onward is the new one.
        expect(window.WanderSync.getState().link)
            .toBe('https://mase.fi/wander/rugged-pine-42#t=tok-rp42');
    });

    test.each(['/explorers/rugged-pine-42', '/wanderlust/rugged-pine-42'])(
        'the prefix regex does not match the lookalike path %s',
        async (path) => {
            // The alternation needs its slashes — a bare substring test would
            // read both of these as account links and prompt to adopt.
            setLocation(path, '#t=tok-rp42');
            setLocalStorage({});
            const confirmSpy = vi.spyOn(window, 'confirm');
            const fetchSpy = vi.fn();
            global.fetch = fetchSpy;
            loadSync();
            await window.WanderSync.init();
            expect(confirmSpy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(window.WanderSync.getState().state).toBe('anonymous');
        }
    );
});
