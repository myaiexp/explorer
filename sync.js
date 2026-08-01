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
// Load order: net.js (for fetchWithTimeout) + sync-flush.js + sync-sections.js
// BEFORE this; this BEFORE app.js.

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

    // Derive the in-memory state from the stored consent record — the single
    // answer to "what is this device bound to when we are NOT adopting a URL
    // account?". Every such path routes through here: no URL segment, a bare link
    // with no token, a cancelled adopt/switch, and a switch whose download failed.
    // The rule used to be written out at each site (an if/else chain in one, a
    // nested ternary in another), and the copies diverged: the account-switch
    // paths only handled 'declined' and dropped an already-bound device to
    // 'anonymous' while localStorage still said accepted — mutate() then no-oped
    // for the rest of the session, so walks stopped syncing with no UI signal.
    function restoreFromConsent(consent) {
        if (consent && consent.state === 'accepted') {
            _state = 'accepted';
            _username = consent.username;
            _token = consent.token || null;
            return;
        }
        _state = (consent && consent.state === 'declined') ? 'declined' : 'anonymous';
        _username = null;
        _token = null;
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
        // Bad percent-encoding (#t=%, #t=%ZZ) must not throw URIError into init —
        // that would skip first paint (lists, visited layer, hash restore).
        var m = (location.hash || '').match(/[#&]t=([^&]+)/);
        if (!m) return null;
        try {
            return decodeURIComponent(m[1]);
        } catch (e) {
            return null;
        }
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

    // Guarded toast — sync.js owns no DOM of its own and toast.js may not be
    // loaded (unit tests, or before the deferred script runs), so resolve the
    // helper off globalThis at call time and no-op if it isn't there.
    function notifyError(message) {
        if (typeof globalThis.showError === 'function') { globalThis.showError(message); }
    }

    // Download an account's four sections and apply each via hooks.applySection
    // (mergeSection on the user's own device, populateSection on a fresh load).
    // Shared by init's three load paths — they differ only in the hooks, which
    // are named rather than positional so a call site reads without a trip to
    // this definition (and so beforeApply's ordering isn't implied by its slot).
    //
    // hooks:
    //   applySection(section, rows) → false on a write that didn't land. Required.
    //   beforeApply()  runs once the download has SUCCEEDED and before any section
    //                  is written — the account-switch path wipes local data here,
    //                  deferred so a failed fetch can't destroy the user's walks
    //                  before the replacement has actually arrived.
    //   onSuccess()    after a successful download (bind + persist consent).
    //   onFail()       on a non-ok response, a network error, or an apply that
    //                  could not be completed after a destructive beforeApply —
    //                  roll back the tentatively-set auth state.
    function loadAccount(username, hooks) {
        var applySection = hooks.applySection;
        var beforeApply = hooks.beforeApply;
        var onSuccess = hooks.onSuccess;
        var onFail = hooks.onFail;

        return apiFetch('GET', [username]).then(function (res) {
            if (!res.ok) { if (onFail) { onFail(); } return; }
            return res.json().then(function (data) {
                // beforeApply is destructive (it wipes local data), so capture what
                // it is about to erase. A write that fails partway through the apply
                // below would otherwise leave the device wiped holding only part of
                // the new account — the same data-loss class the deferred wipe was
                // written to close, reached through the write side instead.
                var snapshot = beforeApply ? Sections.snapshotSections() : null;
                if (beforeApply) { beforeApply(); }

                // Apply every section even when one fails. A section that overflows
                // quota returns false (storage.js has already trimmed what it can and
                // toasted); aborting the loop there would strand the remaining
                // sections for no benefit.
                var applied = true;
                Sections.DATA_SECTIONS.forEach(function (s) {
                    if (!Array.isArray(data[s])) { return; }
                    try {
                        if (applySection(s, data[s]) === false) { applied = false; }
                    } catch (e) {
                        applied = false;
                        console.warn('[sync] could not apply section ' + s, e);
                    }
                });

                if (!applied && snapshot) {
                    // The wipe already ran, so a partial apply here IS data loss.
                    // Roll the whole switch back: restore what we erased, drop the
                    // tentatively-set token, and do not bind the account.
                    var restored = Sections.restoreSections(snapshot);
                    notifyError(restored
                        ? 'Could not load that account — your previous data was restored.'
                        : 'Could not load that account, and some local data could not be restored.');
                    if (onFail) { onFail(); }
                    return;
                }
                if (!applied) {
                    // Nothing was wiped, so a failed write leaves that section's
                    // previous value in place — degraded, not lost. storage.js has
                    // already toasted; carry on so the sections that did land render.
                    console.warn('[sync] account ' + username + ' applied only partially (storage full)');
                }
                if (onSuccess) { onSuccess(); }
            });
        }).catch(function (e) {
            // Fetch/JSON failures only — apply errors are handled above, so this no
            // longer silently swallows a data-loss bug as if it were a network blip.
            console.warn('[sync] could not load account ' + username, e);
            if (onFail) { onFail(); }
        });
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

    // Named rather than inline so _destroy() below can detach it. The page keeps
    // this listener for its whole lifetime; only a test realm — which re-runs this
    // IIFE on one shared window — ever needs to take it back off.
    function handleOnline() { flushWorker.onOnline(); }
    window.addEventListener('online', handleOnline);

    // ── Public API ───────────────────────────────────────────────────────────────

    var ExplorerSync = {

        // The consent/URL state machine. Wrapped by init() below, which kicks the
        // flush pump once this settles so a queue that survived a restart drains.
        _runInit: function () {
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
            // The adopt failed after _token was set tentatively: fall back to
            // whatever this device was already bound to. Nulling only the token
            // (the old behaviour) left an accepted device stranded at 'anonymous'.
            function rollbackAdopt() { restoreFromConsent(consent); }

            // ── Case 1: no URL segment ──────────────────────────────────────────
            if (!urlUser) {
                restoreFromConsent(consent);
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
                // fireStateChange on success so the UI re-renders the merged rows
                // (the adopt paths below already fire it via bindAdoptedAccount).
                return loadAccount(urlUser, {
                    applySection: Sections.mergeSection,
                    onSuccess: fireStateChange
                });
            }

            // Loading a NEW/different account from the URL requires the secret
            // token from the link fragment. A bare link on a fresh device has no
            // credential, so there is nothing to load — keep current local state.
            if (!urlToken) {
                restoreFromConsent(consent);
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
                    restoreFromConsent(consent);
                    return Promise.resolve();
                }
                _token = urlToken;
                return loadAccount(urlUser, {
                    applySection: Sections.populateSection,
                    onSuccess: bindAdoptedAccount,
                    onFail: rollbackAdopt
                });
            }

            // Case 4/5: URL segment + token with non-empty localStorage or different stored user
            var storedUser = (consent && consent.state === 'accepted') ? consent.username : null;
            var msg = storedUser
                ? 'Switching to account ' + urlUser + ' from ' + storedUser + ' — your local data will be replaced.'
                : 'Loading account ' + urlUser + ' — this will replace your current local data.';

            var confirmed = window.confirm(msg + '\n\n[Continue / Cancel]');
            if (!confirmed) {
                history.replaceState(null, '', '/explorer/');
                restoreFromConsent(consent);
                return Promise.resolve();
            }

            // Confirmed — download first, wipe-and-populate only once the account
            // data has actually landed. Wiping up front meant a failed GET (network
            // error or non-ok) erased the user's walks/favourites/history with
            // nothing loaded in exchange — one transient failure = permanent data
            // loss. Passing wipeSections as beforeApply defers the wipe into
            // loadAccount's success path, so a failure leaves the device untouched.
            _token = urlToken;
            return loadAccount(urlUser, {
                applySection: Sections.populateSection,
                beforeApply: Sections.wipeSections,
                onSuccess: bindAdoptedAccount,
                onFail: rollbackAdopt
            });
        },

        init: function () {
            // Start the flush pump once the state machine settles: a mutation
            // persisted to the durable outbox but not drained before the tab
            // closed is otherwise only pumped by a fresh enqueue() or the 'online'
            // event — neither fires on a normal reload while already online. So a
            // queue that survived the restart would strand until the next mutation.
            // scheduleFlush(0) rather than onOnline(): this is a fresh worker with
            // no backoff state to reset, and flushHead's own guards no-op when the
            // queue is empty (see sync-flush.js).
            return ExplorerSync._runInit().then(function (result) {
                if (_state === 'accepted') { flushWorker.scheduleFlush(0); }
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
