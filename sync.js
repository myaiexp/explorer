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
    var DATA_KEYS = {
        visits: 'walk_visits',
        favorites: 'walk_favorites',
        savedLocations: 'walk_saved_locations',
        history: 'walk_history'
    };
    var USERNAME_RE = /^[a-z]+-[a-z]+-\d{1,2}$/;
    var API_BASE = '/explorer/api';

    // ── Internal state ──────────────────────────────────────────────────────────

    var _state = 'anonymous';   // 'anonymous' | 'accepted' | 'declined'
    var _username = null;
    var _token = null;          // per-account secret; sent as Bearer on every request
    var _flushing = false;
    var _backoffMs = 0;
    var _backoffTimer = null;
    var BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 60000];

    // ── Helpers ─────────────────────────────────────────────────────────────────

    function readFlag() {
        try {
            var raw = localStorage.getItem(BACKUP_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeFlag(obj) {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(obj));
    }

    function clearFlag() {
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

    function readSection(section) {
        try {
            var raw = localStorage.getItem(DATA_KEYS[section]);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    function isLocalStorageEmpty() {
        var sections = Object.keys(DATA_KEYS);
        for (var i = 0; i < sections.length; i++) {
            var raw = localStorage.getItem(DATA_KEYS[sections[i]]);
            if (raw) {
                try {
                    var arr = JSON.parse(raw);
                    if (Array.isArray(arr) && arr.length > 0) { return false; }
                } catch (e) { /* skip */ }
            }
        }
        return true;
    }

    function mergeSection(section, serverRows) {
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
                var et = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
                var rt = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
                if (rt >= et) { byId[row.id] = row; }
            }
        });
        var merged = Object.keys(byId).map(function (id) { return byId[id]; });
        localStorage.setItem(DATA_KEYS[section], JSON.stringify(merged));
    }

    function populateSection(section, serverRows) {
        localStorage.setItem(DATA_KEYS[section], JSON.stringify(serverRows));
    }

    function wipeSections() {
        Object.keys(DATA_KEYS).forEach(function (s) {
            localStorage.removeItem(DATA_KEYS[s]);
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

    function doFlush() {
        if (_flushing) { return; }
        if (_state !== 'accepted' || !_username) { return; }
        var outbox = parseOutbox();
        if (outbox.length === 0) { return; }

        _flushing = true;
        var entry = outbox[0];
        var path = '/' + _username + '/' + entry.section + '/' + entry.id;
        var method = entry.op === 'delete' ? 'DELETE' : 'PUT';
        var body = entry.op === 'delete' ? undefined : entry.data;

        apiFetch(method, path, body).then(function (res) {
            _flushing = false;
            _backoffMs = 0;

            if (res.status >= 200 && res.status < 300) {
                var current = parseOutbox();
                current.shift();
                saveOutbox(current);
                if (current.length > 0) {
                    scheduleFlush(0);
                }
                return;
            }

            if (res.status === 429) {
                var retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
                scheduleFlush(retryAfter * 1000);
                return;
            }

            if (res.status >= 400 && res.status < 500) {
                console.warn('[ExplorerSync] Dropping outbox entry due to ' + res.status, entry);
                var current2 = parseOutbox();
                current2.shift();
                saveOutbox(current2);
                if (current2.length > 0) {
                    scheduleFlush(0);
                }
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
            var flag = readFlag();
            var urlUser = parseUrlUsername();
            var urlToken = parseUrlToken();

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
                return apiFetch('GET', '/' + urlUser).then(function (res) {
                    if (!res.ok) { return; }
                    return res.json().then(function (data) {
                        ['visits', 'favorites', 'savedLocations', 'history'].forEach(function (s) {
                            if (Array.isArray(data[s])) { mergeSection(s, data[s]); }
                        });
                    });
                }).catch(function () { /* silent */ });
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

            // Case 3: URL segment + token, no flag, localStorage empty → auto-load
            if (!flag && isLocalStorageEmpty()) {
                _token = urlToken;
                return apiFetch('GET', '/' + urlUser).then(function (res) {
                    if (!res.ok) { _token = null; return; }
                    return res.json().then(function (data) {
                        ['visits', 'favorites', 'savedLocations', 'history'].forEach(function (s) {
                            if (Array.isArray(data[s])) { populateSection(s, data[s]); }
                        });
                        writeFlag({ state: 'accepted', username: urlUser, token: urlToken });
                        _state = 'accepted';
                        _username = urlUser;
                        fireStateChange();
                    });
                }).catch(function () { _token = null; });
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
            return apiFetch('GET', '/' + urlUser).then(function (res) {
                if (!res.ok) { _token = null; return; }
                return res.json().then(function (data) {
                    ['visits', 'favorites', 'savedLocations', 'history'].forEach(function (s) {
                        if (Array.isArray(data[s])) { populateSection(s, data[s]); }
                    });
                    writeFlag({ state: 'accepted', username: urlUser, token: urlToken });
                    _state = 'accepted';
                    _username = urlUser;
                    fireStateChange();
                });
            }).catch(function () { _token = null; });
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
                    localStorage.setItem(DATA_KEYS.savedLocations, JSON.stringify(locs));
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
                    writeFlag({ state: 'accepted', username: username, token: token });
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
            writeFlag({ state: 'declined' });
            _state = 'declined';
            fireStateChange();
        },

        deleteAccount: function () {
            if (!_username) { return Promise.resolve(); }
            var usernameToDelete = _username;
            return apiFetch('DELETE', '/' + usernameToDelete).then(function (res) {
                if (!res.ok) { throw new Error('DELETE account failed: ' + res.status); }
                clearFlag();
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
                return new Promise(function (resolve) {
                    var check = function () {
                        if (!_flushing && parseOutbox().length === 0) {
                            resolve();
                        } else {
                            setTimeout(check, 10);
                        }
                    };
                    doFlush();
                    check();
                });
            }
        }
    };

    window.ExplorerSync = ExplorerSync;

}());
