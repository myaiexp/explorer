// Cloud-backup consent/URL state machine — the five cases that decide what
// account this browser is bound to on load, plus the account download they
// share. Split out of sync.js, which kept growing past the 300-line limit while
// this half stayed a self-contained concept: it runs exactly once per page load
// and nothing else in sync.js calls into it.
//
// Like sync-flush.js it holds no state of its own — the host injects an
// authenticated apiFetch, the consent-record accessors, and two auth setters, so
// the auth triple (_state/_username/_token) keeps a single owner in sync.js.
//
// Load order: sync-sections.js BEFORE this (the section helpers are read off
// globalThis.SyncSections at construction); this BEFORE sync.js.

(function () {
    'use strict';

    // deps:
    //   apiFetch(method, segments, body) → Promise<Response>, Bearer-authenticated
    //   readConsentRecord()  → the stored { state, username?, token? } or null
    //   writeConsentRecord(obj)
    //   setAuth(state, username, token)  replace the whole auth triple
    //   setToken(token)                  set the token alone, before a fetch that
    //                                    needs it and might yet be rolled back
    //   fireStateChange()
    //   usernamePattern      RegExp the URL segment must match to be a username
    globalThis.createSyncInit = function (deps) {
        var apiFetch = deps.apiFetch;
        var readConsentRecord = deps.readConsentRecord;
        var writeConsentRecord = deps.writeConsentRecord;
        var setAuth = deps.setAuth;
        var setToken = deps.setToken;
        var fireStateChange = deps.fireStateChange;
        var usernamePattern = deps.usernamePattern;

        var Sections = globalThis.SyncSections;

        // ── URL parsing ─────────────────────────────────────────────────────────

        function parseUrlUsername() {
            // Matches /explorer/<username> anywhere in pathname
            var m = location.pathname.match(/\/explorer\/([^/?#]+)/);
            if (!m) { return null; }
            var candidate = m[1];
            return usernamePattern.test(candidate) ? candidate : null;
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
                setAuth('accepted', consent.username, consent.token || null);
                return;
            }
            setAuth((consent && consent.state === 'declined') ? 'declined' : 'anonymous', null, null);
        }

        // Guarded toast — this module owns no DOM of its own and toast.js may not
        // be loaded (unit tests, or before the deferred script runs), so resolve the
        // helper off globalThis at call time and no-op if it isn't there.
        function notifyError(message) {
            if (typeof globalThis.showError === 'function') { globalThis.showError(message); }
        }

        // ── Account download ────────────────────────────────────────────────────

        // Download an account's four sections and apply each via hooks.applySection
        // (mergeSection on the user's own device, populateSection on a fresh load).
        // Shared by the three load paths below — they differ only in the hooks, which
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

        // ── The state machine ───────────────────────────────────────────────────

        // Runs once per page load. Resolves when the auth triple has settled; the
        // caller kicks the flush pump off that.
        function run() {
            var consent = readConsentRecord();
            var urlUser = parseUrlUsername();
            var urlToken = parseUrlToken();

            // Adopting a URL-sourced account (Cases 3 & 4/5): on a successful
            // download bind + persist consent; on failure roll back the token that
            // was set tentatively before the fetch.
            function bindAdoptedAccount() {
                writeConsentRecord({ state: 'accepted', username: urlUser, token: urlToken });
                setAuth('accepted', urlUser, urlToken);
                fireStateChange();
            }
            // The adopt failed after the token was set tentatively: fall back to
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
                setAuth('accepted', urlUser, consent.token || urlToken || null);
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
                setToken(urlToken);
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
            setToken(urlToken);
            return loadAccount(urlUser, {
                applySection: Sections.populateSection,
                beforeApply: Sections.wipeSections,
                onSuccess: bindAdoptedAccount,
                onFail: rollbackAdopt
            });
        }

        return { run: run };
    };

}());
