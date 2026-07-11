// Cloud-backup sync engine — consent/account state machine + public API. The
// two data-heavy sub-concerns live in sibling modules this file composes:
//   • sync-flush.js    — the durable outbox + single-flight backoff flush worker
//   • sync-sections.js — read/merge/normalize/write of the four synced sections
//
// Consent-toast hook contract:
//   Register: window.ExplorerSyncUI = { showConsentToast: function() { return Promise<'accepted'|'declined'> } }
//   showConsentToast() must return a Promise that resolves to 'accepted' or 'declined'.
//   If window.ExplorerSyncUI?.showConsentToast is not set, requestConsent() falls back to window.confirm().
//
// Load order: sync-flush.js + sync-sections.js BEFORE this; this BEFORE app.js.

(function () {
    'use strict';

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
                Sections.DATA_SECTIONS.forEach(function (s) {
                    if (Array.isArray(data[s])) { applyRow(s, data[s]); }
                });
                if (onSuccess) { onSuccess(); }
            });
        }).catch(function () { if (onFail) { onFail(); } });
    }

    // ── Flush worker ─────────────────────────────────────────────────────────────

    // The outbox + backoff pump lives in sync-flush.js. It reads none of this
    // module's state directly: getUsername() gates flushing on accepted + a bound
    // username, and apiFetch carries the Bearer token.
    var flushWorker = globalThis.createSyncFlushWorker({
        apiFetch: apiFetch,
        getUsername: function () { return _state === 'accepted' ? _username : null; }
    });

    // ── Online listener ──────────────────────────────────────────────────────────

    window.addEventListener('online', function () { flushWorker.onOnline(); });

    // ── Public API ───────────────────────────────────────────────────────────────

    var ExplorerSync = {

        init: function () {
            var consent = readConsentRecord();
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
                if (consent && consent.state === 'accepted') {
                    _state = 'accepted';
                    _username = consent.username;
                    _token = consent.token || null;
                } else if (consent && consent.state === 'declined') {
                    _state = 'declined';
                } else {
                    _state = 'anonymous';
                }
                return Promise.resolve();
            }

            // ── Cases with URL segment ──────────────────────────────────────────

            // Case 2: URL matches stored username — the credential comes from the
            // stored consent (the user's own device), so a bare link still works here.
            if (consent && consent.state === 'accepted' && consent.username === urlUser) {
                _state = 'accepted';
                _username = urlUser;
                _token = consent.token || urlToken || null;
                // Own device: merge server rows into local (last-write-wins). A
                // failed GET is silently ignored — state is already 'accepted'.
                return loadAccount(urlUser, Sections.mergeSection);
            }

            // Loading a NEW/different account from the URL requires the secret
            // token from the link fragment. A bare link on a fresh device has no
            // credential, so there is nothing to load — keep current local state.
            if (!urlToken) {
                if (consent && consent.state === 'accepted') {
                    _state = 'accepted';
                    _username = consent.username;
                    _token = consent.token || null;
                } else {
                    _state = consent && consent.state === 'declined' ? 'declined' : 'anonymous';
                }
                return Promise.resolve();
            }

            // Case 3: URL segment + token, no consent, localStorage empty.
            // Loading a URL-sourced account binds this browser to it: every
            // future walk, favourite, and saved location syncs there, and anyone
            // holding the link can read it back. Even on an empty device this
            // must be consented to — otherwise a shared link silently hijacks a
            // fresh browser into uploading the visitor's data to a foreign
            // account. Gate it with the same confirm used for Cases 4/5.
            if (!consent && Sections.isLocalStorageEmpty()) {
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
                return loadAccount(urlUser, Sections.populateSection, bindAdoptedAccount, rollbackToken);
            }

            // Case 4/5: URL segment + token with non-empty localStorage or different stored user
            var storedUser = (consent && consent.state === 'accepted') ? consent.username : null;
            var msg = storedUser
                ? 'Switching to account ' + urlUser + ' from ' + storedUser + ' — your local data will be replaced.'
                : 'Loading account ' + urlUser + ' — this will replace your current local data.';

            var confirmed = window.confirm(msg + '\n\n[Continue / Cancel]');
            if (!confirmed) {
                history.replaceState(null, '', '/explorer/');
                _state = consent && consent.state === 'declined' ? 'declined' : 'anonymous';
                return Promise.resolve();
            }

            // Confirmed — wipe and load
            _token = urlToken;
            Sections.wipeSections();
            return loadAccount(urlUser, Sections.populateSection, bindAdoptedAccount, rollbackToken);
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
            return apiFetch('POST', '/accounts').then(function (res) {
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
                    localStorage.setItem(Sections.sectionKey('savedLocations'), JSON.stringify(locs));
                }

                // Build full payload
                var payload = {
                    visits: Sections.readSection('visits'),
                    favorites: Sections.readSection('favorites'),
                    savedLocations: Sections.readSection('savedLocations'),
                    history: Sections.readSection('history')
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

        // Test/inspection hook onto the flush worker's outbox.
        _outbox: {
            peek: flushWorker.peek,
            flush: flushWorker.flush
        }
    };

    window.ExplorerSync = ExplorerSync;

}());
