// Cloud-backup sync engine — the auth triple + public API. It owns the
// account/consent state and the authenticated transport; the three data-heavy
// sub-concerns live in sibling modules this file composes:
//   • sync-flush.js    — the durable outbox + single-flight backoff flush worker
//   • sync-sections.js — read/merge/normalize/write of the four synced sections
//   • sync-init.js     — the load-time consent/URL state machine (Cases 1–5)
//   • sync-accept.js   — account creation + the first upload of this device
//
// Consent-toast hook contract:
//   Register: window.WanderSyncUI = { showConsentToast: function() { return Promise<'accepted'|'declined'> } }
//   showConsentToast() must return a Promise that resolves to 'accepted' or 'declined'.
//   If window.WanderSyncUI?.showConsentToast is not set, requestConsent() falls back to window.confirm().
//
// Load order: net.js (for fetchWithTimeout) + sync-flush.js + sync-sections.js
// + sync-init.js + sync-accept.js BEFORE this; this BEFORE app.js.

(function () {
    'use strict';

    // Origin-scoped on https://mase.fi, not path-scoped. XSS anywhere on this
    // origin can read the bearer — accepted same-origin trust: the client must
    // hold plaintext so share-links can put it in the fragment (the API stores
    // only a hash). See server/README.md "Client contract".
    var BACKUP_KEY = 'walk_cloud_backup';
    var USERNAME_RE = /^[a-z]+-[a-z]+-\d{1,2}$/;
    // One absolute constant, deliberately NOT derived from location.pathname:
    // a page served at /explorer/… calling /wander/api is same-origin, so the
    // CSP's connect-src 'self' already permits it, and one constant cannot
    // drift out of sync with the prefix it was loaded under. nginx keeps an
    // /explorer/api/ proxy anyway, for pages loaded before the rename.
    var API_BASE = '/wander/api';

    // The four synced sections + their local-data helpers live in sync-sections.js.
    var Sections = globalThis.SyncSections;

    // ── Internal state ──────────────────────────────────────────────────────────

    var _state = 'anonymous';   // 'anonymous' | 'accepted' | 'declined'
    var _username = null;
    var _token = null;          // per-account secret; sent as Bearer on every request
    var _holdFlush = false;     // pump parked while init() settles — see there

    // ── Helpers ─────────────────────────────────────────────────────────────────

    // The consent record persisted under BACKUP_KEY is a structured record:
    // { state: 'accepted'|'declined', username?, token? } — the user's
    // backup-consent decision plus the account it is bound to.
    function readConsentRecord() {
        try {
            var raw = localStorage.getItem(BACKUP_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeConsentRecord(obj) {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(obj));
    }

    function clearConsentRecord() {
        localStorage.removeItem(BACKUP_KEY);
    }

    // The auth triple has exactly one owner (this file), so sync-init.js and
    // sync-accept.js mutate it through these two setters rather than reaching into the closure.
    // setToken alone is the tentative-credential step: an adopt sets the token
    // before the download that might yet roll it back, leaving state/username
    // untouched until the account has actually landed.
    function setAuth(state, username, token) {
        _state = state;
        _username = username;
        _token = token;
    }

    function setToken(token) {
        _token = token;
    }

    function fireStateChange() {
        try {
            window.dispatchEvent(new CustomEvent('wander-sync-state-change'));
        } catch (e) {
            // ignore in envs without CustomEvent
        }
    }

    // ── Fetch helpers ────────────────────────────────────────────────────────────

    // Every request path is built from SEGMENTS, never a string the caller
    // concatenated: a segment can carry user-supplied text — an imported visit's
    // id (importVisits takes ids verbatim from an uploaded backup file), or a
    // username read straight out of the URL — and a raw '/' or '..' inside one is
    // normalized by the browser before the request leaves, silently redirecting
    // an authenticated (Bearer-token) write to a different endpoint. Encoding
    // here rather than at each call site is what makes that impossible to forget
    // when a new endpoint is added.
    function apiPath(segments) {
        var encoded = [];
        for (var i = 0; i < segments.length; i++) {
            encoded.push(encodeURIComponent(String(segments[i])));
        }
        return '/' + encoded.join('/');
    }

    function apiFetch(method, segments, body) {
        var headers = { 'Content-Type': 'application/json' };
        if (_token) { headers['Authorization'] = 'Bearer ' + _token; }
        var opts = {
            method: method,
            headers: headers
        };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        }
        // Timeout so a stalled request rejects instead of wedging the flush pump
        // (a hung apiFetch would keep _flushing = true and freeze the outbox).
        // The flush worker's .catch already treats a rejection as a retryable
        // failure, so the abort just triggers its normal backoff-and-retry.
        return fetchWithTimeout(API_BASE + apiPath(segments), opts);
    }

    // ── Load-time state machine ──────────────────────────────────────────────────

    // The consent/URL cases live in sync-init.js. It owns no state either: it
    // reads the consent record and the URL, downloads the account, and reports
    // the outcome back through setAuth/setToken.
    var initMachine = globalThis.createSyncInit({
        apiFetch: apiFetch,
        readConsentRecord: readConsentRecord,
        writeConsentRecord: writeConsentRecord,
        setAuth: setAuth,
        setToken: setToken,
        fireStateChange: fireStateChange,
        readOutbox: function () { return flushWorker.peek(); },
        usernamePattern: USERNAME_RE
    });

    // ── Account creation ─────────────────────────────────────────────────────────

    // accept() lives in sync-accept.js, writing the auth triple back through the
    // same two setters sync-init.js uses.
    var acceptAccount = globalThis.createSyncAccept({
        apiFetch: apiFetch,
        writeConsentRecord: writeConsentRecord,
        setAuth: setAuth,
        setToken: setToken,
        fireStateChange: fireStateChange
    });

    // ── Flush worker ─────────────────────────────────────────────────────────────

    // The outbox + backoff pump lives in sync-flush.js. It reads none of this
    // module's state directly: getUsername() gates flushing on accepted + a bound
    // username + no init() in progress, and apiFetch carries the Bearer token.
    var flushWorker = globalThis.createSyncFlushWorker({
        apiFetch: apiFetch,
        getUsername: function () { return (_state === 'accepted' && !_holdFlush) ? _username : null; }
    });

    // ── Online listener ──────────────────────────────────────────────────────────

    // Named rather than inline so _destroy() below can detach it. The page keeps
    // this listener for its whole lifetime; only a test realm — which re-runs this
    // IIFE on one shared window — ever needs to take it back off.
    function handleOnline() { flushWorker.onOnline(); }
    window.addEventListener('online', handleOnline);

    // ── Public API ───────────────────────────────────────────────────────────────

    var WanderSync = {

        // The consent/URL state machine, in sync-init.js. Kept on the public
        // object because init() below wraps it and the tests drive the five cases
        // through it directly.
        _runInit: function () {
            return initMachine.run();
        },

        init: function () {
            // Start the flush pump once the state machine settles: a mutation
            // persisted to the durable outbox but not drained before the tab
            // closed is otherwise only pumped by a fresh enqueue() or the 'online'
            // event — neither fires on a normal reload while already online. So a
            // queue that survived the restart would strand until the next mutation.
            // resume() rather than bare scheduleFlush(0): clears any prior auth
            // hard-stop (401/403 paused the pump without dropping the queue) and
            // re-arms once consent/token is known good. Fresh workers have no
            // backoff to reset; flushHead no-ops when the queue is empty.
            var consent = readConsentRecord();
            var previous = (consent && consent.state === 'accepted') ? consent.username : null;
            // Hold the pump across the state machine. The Case 2 merge tells stale
            // server rows by what is still queued, and its GET can predate a
            // mutation made while it was in flight; an entry flushed in that window
            // would leave the queue first and the merge would put its row back.
            _holdFlush = true;
            return WanderSync._runInit().finally(function () {
                _holdFlush = false;
            }).then(function (result) {
                // Outbox entries have no owner; flushHead builds the path from the
                // current username. Clear only after a successful bind to a
                // different account. A failed or cancelled switch rolls _username
                // back, so previous === _username and that account's queue stays.
                if (previous && _state === 'accepted' && _username && _username !== previous) {
                    flushWorker.clear();
                }
                if (_state === 'accepted') { flushWorker.resume(); }
                return result;
            });
        },

        getState: function () {
            return {
                state: _state,
                username: _username,
                token: _token,
                // Full private link (with the secret in the fragment) for cross-device access.
                link: (_state === 'accepted' && _username && _token)
                    ? location.origin + '/wander/' + _username + '#t=' + _token
                    : null,
                outboxLength: flushWorker.length()
            };
        },

        requestConsent: function () {
            if (window.WanderSyncUI && typeof window.WanderSyncUI.showConsentToast === 'function') {
                return window.WanderSyncUI.showConsentToast();
            }
            // Fallback when no WanderSyncUI.showConsentToast hook is registered
            var ok = window.confirm(
                'Save your walks to the cloud?\n\n' +
                'Your visits, favourites, and saved locations will be backed up ' +
                'and accessible on any device via a private link.\n\n' +
                'OK = Back up  |  Cancel = No thanks'
            );
            if (ok) {
                return WanderSync.accept().then(function () { return 'accepted'; });
            } else {
                WanderSync.decline();
                return Promise.resolve('declined');
            }
        },

        accept: function () {
            return acceptAccount();
        },

        decline: function () {
            writeConsentRecord({ state: 'declined' });
            _state = 'declined';
            fireStateChange();
        },

        deleteAccount: function () {
            if (!_username) { return Promise.resolve(); }
            var usernameToDelete = _username;
            return apiFetch('DELETE', [usernameToDelete]).then(function (res) {
                if (!res.ok) { throw new Error('DELETE account failed: ' + res.status); }
                clearConsentRecord();
                flushWorker.clear();
                _state = 'anonymous';
                _username = null;
                _token = null;
                history.replaceState(null, '', '/wander/');
                fireStateChange();
            });
        },

        mutate: function (section, op, id, data) {
            if (_state !== 'accepted') { return; }
            flushWorker.enqueue({ section: section, op: op, id: id, data: data });
        },

        // Test/inspection hook onto the flush worker's outbox. whenDrained()
        // waits for the queue to empty; it does not itself do the draining.
        _outbox: {
            peek: flushWorker.peek,
            whenDrained: flushWorker.whenDrained
        },

        // Retire this instance: detach the window listener and make the flush
        // worker inert. Only the test harness calls it — reloading this script in
        // a shared realm otherwise strands every prior instance's 'online' handler
        // and backoff timer on the window, all still pumping the one shared outbox
        // key with their own stale username/token.
        _destroy: function () {
            window.removeEventListener('online', handleOnline);
            flushWorker.destroy();
        }
    };

    window.WanderSync = WanderSync;

}());
