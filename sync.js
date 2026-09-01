// Cloud-backup sync engine — the auth triple + public API. It owns the
// account/consent state and the authenticated transport; the three data-heavy
// sub-concerns live in sibling modules this file composes:
//   • sync-flush.js    — the durable outbox + single-flight backoff flush worker
//   • sync-sections.js — read/merge/normalize/write of the four synced sections
//   • sync-init.js     — the load-time consent/URL state machine (Cases 1–5)
//
// Consent-toast hook contract:
//   Register: window.ExplorerSyncUI = { showConsentToast: function() { return Promise<'accepted'|'declined'> } }
//   showConsentToast() must return a Promise that resolves to 'accepted' or 'declined'.
//   If window.ExplorerSyncUI?.showConsentToast is not set, requestConsent() falls back to window.confirm().
//
// Load order: net.js (for fetchWithTimeout) + sync-flush.js + sync-sections.js
// + sync-init.js BEFORE this; this BEFORE app.js.

(function () {
    'use strict';

    // Origin-scoped on https://mase.fi, not path-scoped. XSS anywhere on this
    // origin can read the bearer — accepted same-origin trust: the client must
    // hold plaintext so share-links can put it in the fragment (the API stores
    // only a hash). See server/README.md "Client contract".
    var BACKUP_KEY = 'walk_cloud_backup';
    var USERNAME_RE = /^[a-z]+-[a-z]+-\d{1,2}$/;
    var API_BASE = '/explorer/api';

    // The four synced sections + their local-data helpers live in sync-sections.js.
    var Sections = globalThis.SyncSections;

    // ── Internal state ──────────────────────────────────────────────────────────

    var _state = 'anonymous';   // 'anonymous' | 'accepted' | 'declined'
    var _username = null;
    var _token = null;          // per-account secret; sent as Bearer on every request

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

    // The auth triple has exactly one owner (this file), so sync-init.js mutates
    // it through these two setters rather than reaching into the closure.
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
            window.dispatchEvent(new CustomEvent('explorer-sync-state-change'));
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
        usernamePattern: USERNAME_RE
    });

    // ── Flush worker ─────────────────────────────────────────────────────────────

    // The outbox + backoff pump lives in sync-flush.js. It reads none of this
    // module's state directly: getUsername() gates flushing on accepted + a bound
    // username, and apiFetch carries the Bearer token.
    var flushWorker = globalThis.createSyncFlushWorker({
        apiFetch: apiFetch,
        getUsername: function () { return _state === 'accepted' ? _username : null; }
    });

    // ── Online listener ──────────────────────────────────────────────────────────

    // Named rather than inline so _destroy() below can detach it. The page keeps
    // this listener for its whole lifetime; only a test realm — which re-runs this
    // IIFE on one shared window — ever needs to take it back off.
    function handleOnline() { flushWorker.onOnline(); }
    window.addEventListener('online', handleOnline);

    // ── Public API ───────────────────────────────────────────────────────────────

    var ExplorerSync = {

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
            return ExplorerSync._runInit().then(function (result) {
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
                    ? location.origin + '/explorer/' + _username + '#t=' + _token
                    : null,
                outboxLength: flushWorker.length()
            };
        },

        requestConsent: function () {
            if (window.ExplorerSyncUI && typeof window.ExplorerSyncUI.showConsentToast === 'function') {
                return window.ExplorerSyncUI.showConsentToast();
            }
            // Fallback when no ExplorerSyncUI.showConsentToast hook is registered
            var ok = window.confirm(
                'Save your walks to the cloud?\n\n' +
                'Your visits, favourites, and saved locations will be backed up ' +
                'and accessible on any device via a private link.\n\n' +
                'OK = Back up  |  Cancel = No thanks'
            );
            if (ok) {
                return ExplorerSync.accept().then(function () { return 'accepted'; });
            } else {
                ExplorerSync.decline();
                return Promise.resolve('declined');
            }
        },

        accept: function () {
            return apiFetch('POST', ['accounts']).then(function (res) {
                if (!res.ok) { throw new Error('POST /accounts failed: ' + res.status); }
                return res.json();
            }).then(function (body) {
                var username = body.username;
                var token = body.token;
                // Set the token before the import below — that request is now authenticated.
                _token = token;

                // Assign missing UUIDs to savedLocations
                var locs = Sections.readSection('savedLocations');
                var changed = false;
                locs.forEach(function (loc) {
                    if (!loc.id) {
                        loc.id = crypto.randomUUID();
                        changed = true;
                    }
                });
                if (changed) {
                    Sections.writeSection('savedLocations', locs);
                }

                // Build full payload
                var payload = {
                    visits: Sections.readSection('visits'),
                    favorites: Sections.readSection('favorites'),
                    savedLocations: Sections.readSection('savedLocations'),
                    history: Sections.readSection('history')
                };

                return apiFetch('POST', [username, 'import'], payload).then(function (res2) {
                    if (!res2.ok) { throw new Error('POST /import failed: ' + res2.status); }
                    writeConsentRecord({ state: 'accepted', username: username, token: token });
                    _state = 'accepted';
                    _username = username;
                    // Carry the secret in the fragment so the link itself is the credential.
                    history.replaceState(null, '', '/explorer/' + username + '#t=' + token);
                    fireStateChange();
                }).catch(function (e) {
                    _token = null;   // roll back partial auth state if the import failed
                    throw e;
                });
            });
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
                history.replaceState(null, '', '/explorer/');
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

    window.ExplorerSync = ExplorerSync;

}());
