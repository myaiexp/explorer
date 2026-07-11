// Cloud-backup sync engine — outbox-based per-row mirror to /explorer/api
//
// Consent-toast hook contract:
//   Register: window.ExplorerSyncUI = { showConsentToast: function() { return Promise<'accepted'|'declined'> } }
//   showConsentToast() must return a Promise that resolves to 'accepted' or 'declined'.
//   If window.ExplorerSyncUI?.showConsentToast is not set, requestConsent() falls back to window.confirm().
//
// Load order: <script src="sync.js"> BEFORE <script src="app.js">

(function () {
    'use strict';

    var BACKUP_KEY = 'walk_cloud_backup';
    var OUTBOX_KEY = 'walk_sync_outbox';
    // The four synced sections, in sync order. These names are sync.js's own
    // vocabulary — they key the server's GET response and the outbox entries.
    // The 'walk_*' localStorage keys they map to are owned by storage.js (loaded
    // alongside us); sectionKey() resolves each from storage.js's globals so the
    // key strings have exactly one home and a rename there can't silently fork.
    var DATA_SECTIONS = ['visits', 'favorites', 'savedLocations', 'history'];
    var USERNAME_RE = /^[a-z]+-[a-z]+-\d{1,2}$/;
    var API_BASE = '/explorer/api';

    // ── Internal state ──────────────────────────────────────────────────────────

    var _state = 'anonymous';   // 'anonymous' | 'accepted' | 'declined'
    var _username = null;
    var _token = null;          // per-account secret; sent as Bearer on every request
    var _flushing = false;
    var _backoffMs = 0;
    var _backoffTimer = null;
    var _flushWaiters = [];     // resolve callbacks awaiting a fully-drained outbox
    var BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 60000];

    // ── Helpers ─────────────────────────────────────────────────────────────────

    // The consent record persisted under BACKUP_KEY is not a boolean: it is
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

    function parseOutbox() {
        try {
            var raw = localStorage.getItem(OUTBOX_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    function saveOutbox(entries) {
        localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
    }

    function clearOutbox() {
        localStorage.removeItem(OUTBOX_KEY);
    }

    function parseUrlUsername() {
        // Matches /explorer/<username> anywhere in pathname
        var m = location.pathname.match(/\/explorer\/([^/?#]+)/);
        if (!m) { return null; }
        var candidate = m[1];
        return USERNAME_RE.test(candidate) ? candidate : null;
    }

    function parseUrlToken() {
        // Secret token carried in the URL fragment as #t=<token>. Fragments are
        // never sent to the server, so the token stays out of access logs and
        // Referer headers — the full link is the private capability.
        var m = (location.hash || '').match(/[#&]t=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function fireStateChange() {
        try {
            window.dispatchEvent(new CustomEvent('explorer-sync-state-change'));
        } catch (e) {
            // ignore in envs without CustomEvent
        }
    }

    // Section's localStorage key, resolved from storage.js's globals at call time
    // (they aren't set at our IIFE time — storage.js loads after sync.js — but are
    // by the time any method here runs). storage.js is the single owner of these
    // key strings; resolving them here keeps sync.js from forking a second copy.
    function sectionKey(section) {
        switch (section) {
            case 'visits': return globalThis.VISITS_KEY;
            case 'favorites': return globalThis.FAVORITES_KEY;
            case 'savedLocations': return globalThis.SAVED_LOCATIONS_KEY;
            case 'history': return globalThis.HISTORY_KEY;
            default: return undefined;
        }
    }

    // Delegates the parse-or-default contract to storage.js's readStoredArray so
    // it lives in exactly one place (corrupt/missing → []).
    function readSection(section) {
        return globalThis.readStoredArray(sectionKey(section));
    }

    function isLocalStorageEmpty() {
        for (var i = 0; i < DATA_SECTIONS.length; i++) {
            var arr = readSection(DATA_SECTIONS[i]);
            if (Array.isArray(arr) && arr.length > 0) { return false; }
        }
        return true;
    }

    // The favorites section is stored server-side as {id, username, payload, updatedAt}
    // where payload is the flat favorite blob; every other section already comes back
    // flat (typed columns). Unwrap favorites to the flat shape the app + renderer read
    // (f.destLat, f.destName, …), preserving id + updatedAt for last-write-wins. Without
    // this a synced-down favorite stays {id, payload:{…}} and crashes the renderer (#2065).
    function normalizeServerRows(section, serverRows) {
        if (section !== 'favorites') { return serverRows; }
        return serverRows.map(function (row) {
            if (!row || typeof row.payload !== 'object' || row.payload === null) { return row; }
            var flat = Object.assign({}, row.payload, { id: row.id });
            if (row.updatedAt !== undefined) { flat.updatedAt = row.updatedAt; }
            return flat;
        });
    }

    function mergeSection(section, serverRows) {
        serverRows = normalizeServerRows(section, serverRows);
        // Last-write-wins by updatedAt per id
        var local = readSection(section);
        var byId = {};
        local.forEach(function (row) { if (row.id) { byId[row.id] = row; } });
        serverRows.forEach(function (row) {
            if (!row.id) { return; }
            var existing = byId[row.id];
            if (!existing) {
                byId[row.id] = row;
            } else {
                var existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
                var rowTs = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
                if (rowTs >= existingTs) { byId[row.id] = row; }
            }
        });
        var merged = Object.keys(byId).map(function (id) { return byId[id]; });
        localStorage.setItem(sectionKey(section), JSON.stringify(merged));
    }

    function populateSection(section, serverRows) {
        localStorage.setItem(sectionKey(section), JSON.stringify(normalizeServerRows(section, serverRows)));
    }

    function wipeSections() {
        DATA_SECTIONS.forEach(function (s) {
            localStorage.removeItem(sectionKey(s));
        });
    }

    // ── Fetch helpers ────────────────────────────────────────────────────────────

    function apiFetch(method, path, body) {
        var headers = { 'Content-Type': 'application/json' };
        if (_token) { headers['Authorization'] = 'Bearer ' + _token; }
        var opts = {
            method: method,
            headers: headers
        };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        }
        return fetch(API_BASE + path, opts);
    }

    // Download an account's four sections and apply each via applyRow
    // (mergeSection on the user's own device, populateSection on a fresh load).
    // onSuccess runs after a successful download (bind + persist consent); onFail
    // runs on a non-ok response or a network error (roll back partial auth state).
    // Shared by init's three load paths — they differ only in applyRow and hooks.
    function loadAccount(username, applyRow, onSuccess, onFail) {
        return apiFetch('GET', '/' + username).then(function (res) {
            if (!res.ok) { if (onFail) { onFail(); } return; }
            return res.json().then(function (data) {
                DATA_SECTIONS.forEach(function (s) {
                    if (Array.isArray(data[s])) { applyRow(s, data[s]); }
                });
                if (onSuccess) { onSuccess(); }
            });
        }).catch(function () { if (onFail) { onFail(); } });
    }

    // ── Flush worker ─────────────────────────────────────────────────────────────

    function scheduleFlush(delayMs) {
        if (_backoffTimer !== null) { return; }
        if (delayMs > 0) {
            _backoffTimer = setTimeout(function () {
                _backoffTimer = null;
                doFlush();
            }, delayMs);
        } else {
            // Use a microtask so callers finish before we start
            Promise.resolve().then(doFlush);
        }
    }

    function nextBackoff(current) {
        for (var i = 0; i < BACKOFF_STEPS.length; i++) {
            if (current < BACKOFF_STEPS[i]) { return BACKOFF_STEPS[i]; }
        }
        return BACKOFF_STEPS[BACKOFF_STEPS.length - 1];
    }

    // Resolve any pending _outbox.flush() promises once the queue is fully
    // drained and no flush is in flight. The event-based completion signal that
    // replaces the old 10 ms polling loop.
    function settleFlushWaiters() {
        if (_flushing) { return; }
        if (parseOutbox().length > 0) { return; }
        var waiters = _flushWaiters;
        _flushWaiters = [];
        for (var i = 0; i < waiters.length; i++) { waiters[i](); }
    }

    // Drop the head entry just processed (re-reading the outbox so a concurrent
    // mutate() enqueued during the in-flight request is preserved), persist, and
    // either reschedule for the next entry or signal flush completion.
    function consumeOutboxHead() {
        var remaining = parseOutbox();
        remaining.shift();
        saveOutbox(remaining);
        if (remaining.length > 0) {
            scheduleFlush(0);
        }
        settleFlushWaiters();
    }

    function doFlush() {
        if (_flushing) { return; }
        if (_state !== 'accepted' || !_username) { settleFlushWaiters(); return; }
        var outbox = parseOutbox();
        if (outbox.length === 0) { settleFlushWaiters(); return; }

        _flushing = true;
        var entry = outbox[0];
        var path = '/' + _username + '/' + entry.section + '/' + entry.id;
        var method = entry.op === 'delete' ? 'DELETE' : 'PUT';
        var body = entry.op === 'delete' ? undefined : entry.data;

        apiFetch(method, path, body).then(function (res) {
            _flushing = false;
            _backoffMs = 0;

            if (res.status >= 200 && res.status < 300) {
                consumeOutboxHead();
                return;
            }

            if (res.status === 429) {
                var retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
                scheduleFlush(retryAfter * 1000);
                return;
            }

            if (res.status >= 400 && res.status < 500) {
                console.warn('[ExplorerSync] Dropping outbox entry due to ' + res.status, entry);
                consumeOutboxHead();
                return;
            }

            // 5xx or unexpected — exponential backoff
            _backoffMs = nextBackoff(_backoffMs);
            scheduleFlush(_backoffMs);

        }).catch(function () {
            _flushing = false;
            _backoffMs = nextBackoff(_backoffMs);
            scheduleFlush(_backoffMs);
        });
    }

    // ── Online listener ──────────────────────────────────────────────────────────

    window.addEventListener('online', function () {
        if (_backoffTimer !== null) {
            clearTimeout(_backoffTimer);
            _backoffTimer = null;
        }
        _backoffMs = 0;
        scheduleFlush(0);
    });

    // ── Public API ───────────────────────────────────────────────────────────────

    var ExplorerSync = {

        init: function () {
            var flag = readConsentRecord();
            var urlUser = parseUrlUsername();
            var urlToken = parseUrlToken();

            // Adopting a URL-sourced account (Cases 3 & 4/5): on a successful
            // download bind + persist consent; on failure roll back the token that
            // was set tentatively before the fetch.
            function bindAdoptedAccount() {
                writeConsentRecord({ state: 'accepted', username: urlUser, token: urlToken });
                _state = 'accepted';
                _username = urlUser;
                fireStateChange();
            }
            function rollbackToken() { _token = null; }

            // ── Case 1: no URL segment ──────────────────────────────────────────
            if (!urlUser) {
                if (flag && flag.state === 'accepted') {
                    _state = 'accepted';
                    _username = flag.username;
                    _token = flag.token || null;
                } else if (flag && flag.state === 'declined') {
                    _state = 'declined';
                } else {
                    _state = 'anonymous';
                }
                return Promise.resolve();
            }

            // ── Cases with URL segment ──────────────────────────────────────────

            // Case 2: URL matches stored username — the credential comes from the
            // stored flag (the user's own device), so a bare link still works here.
            if (flag && flag.state === 'accepted' && flag.username === urlUser) {
                _state = 'accepted';
                _username = urlUser;
                _token = flag.token || urlToken || null;
                // Own device: merge server rows into local (last-write-wins). A
                // failed GET is silently ignored — state is already 'accepted'.
                return loadAccount(urlUser, mergeSection);
            }

            // Loading a NEW/different account from the URL requires the secret
            // token from the link fragment. A bare link on a fresh device has no
            // credential, so there is nothing to load — keep current local state.
            if (!urlToken) {
                if (flag && flag.state === 'accepted') {
                    _state = 'accepted';
                    _username = flag.username;
                    _token = flag.token || null;
                } else {
                    _state = flag && flag.state === 'declined' ? 'declined' : 'anonymous';
                }
                return Promise.resolve();
            }

            // Case 3: URL segment + token, no flag, localStorage empty.
            // Loading a URL-sourced account binds this browser to it: every
            // future walk, favourite, and saved location syncs there, and anyone
            // holding the link can read it back. Even on an empty device this
            // must be consented to — otherwise a shared link silently hijacks a
            // fresh browser into uploading the visitor's data to a foreign
            // account. Gate it with the same confirm used for Cases 4/5.
            if (!flag && isLocalStorageEmpty()) {
                var adoptConfirmed = window.confirm(
                    'Load shared backup account ' + urlUser + '?\n\n' +
                    'Your walks, favourites, and saved locations on this device will ' +
                    'be backed up to this account, which anyone holding its link can read.\n\n' +
                    '[Continue / Cancel]'
                );
                if (!adoptConfirmed) {
                    history.replaceState(null, '', '/explorer/');
                    _state = 'anonymous';
                    return Promise.resolve();
                }
                _token = urlToken;
                return loadAccount(urlUser, populateSection, bindAdoptedAccount, rollbackToken);
            }

            // Case 4/5: URL segment + token with non-empty localStorage or different stored user
            var storedUser = (flag && flag.state === 'accepted') ? flag.username : null;
            var msg = storedUser
                ? 'Switching to account ' + urlUser + ' from ' + storedUser + ' — your local data will be replaced.'
                : 'Loading account ' + urlUser + ' — this will replace your current local data.';

            var confirmed = window.confirm(msg + '\n\n[Continue / Cancel]');
            if (!confirmed) {
                history.replaceState(null, '', '/explorer/');
                _state = flag && flag.state === 'declined' ? 'declined' : 'anonymous';
                return Promise.resolve();
            }

            // Confirmed — wipe and load
            _token = urlToken;
            wipeSections();
            return loadAccount(urlUser, populateSection, bindAdoptedAccount, rollbackToken);
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
                outboxLength: parseOutbox().length
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
            return apiFetch('POST', '/accounts').then(function (res) {
                if (!res.ok) { throw new Error('POST /accounts failed: ' + res.status); }
                return res.json();
            }).then(function (body) {
                var username = body.username;
                var token = body.token;
                // Set the token before the import below — that request is now authenticated.
                _token = token;

                // Assign missing UUIDs to savedLocations
                var locs = readSection('savedLocations');
                var changed = false;
                locs.forEach(function (loc) {
                    if (!loc.id) {
                        loc.id = crypto.randomUUID();
                        changed = true;
                    }
                });
                if (changed) {
                    localStorage.setItem(sectionKey('savedLocations'), JSON.stringify(locs));
                }

                // Build full payload
                var payload = {
                    visits: readSection('visits'),
                    favorites: readSection('favorites'),
                    savedLocations: readSection('savedLocations'),
                    history: readSection('history')
                };

                return apiFetch('POST', '/' + username + '/import', payload).then(function (res2) {
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
            return apiFetch('DELETE', '/' + usernameToDelete).then(function (res) {
                if (!res.ok) { throw new Error('DELETE account failed: ' + res.status); }
                clearConsentRecord();
                clearOutbox();
                _state = 'anonymous';
                _username = null;
                _token = null;
                history.replaceState(null, '', '/explorer/');
                fireStateChange();
            });
        },

        mutate: function (section, op, id, data) {
            if (_state !== 'accepted') { return; }
            var outbox = parseOutbox();
            outbox.push({ section: section, op: op, id: id, data: data, attempts: 0 });
            saveOutbox(outbox);
            scheduleFlush(0);
        },

        _outbox: {
            peek: function () { return parseOutbox(); },
            flush: function () {
                // Resolves when the outbox is fully drained. Completion is signalled
                // through the flush machinery (settleFlushWaiters) rather than polled.
                return new Promise(function (resolve) {
                    if (!_flushing && parseOutbox().length === 0) {
                        resolve();
                        return;
                    }
                    _flushWaiters.push(resolve);
                    doFlush();
                });
            }
        }
    };

    window.ExplorerSync = ExplorerSync;

}());
