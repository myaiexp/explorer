// Cloud-backup account creation — create an account and upload this device.
// accept() is the one-time handoff from anonymous to accepted: POST /accounts,
// give any id-less saved location a UUID, then import all four local sections
// before the account counts as bound. Nothing else in sync.js calls into it.
//
// Like sync-init.js it holds no state of its own — the host injects an
// authenticated apiFetch, the consent-record writer, and the two auth setters,
// so the auth triple (_state/_username/_token) keeps a single owner in sync.js.
//
// Load order: sync-sections.js BEFORE this (the section helpers are read off
// globalThis.SyncSections at construction); this BEFORE sync.js.

(function () {
    'use strict';

    // deps:
    //   apiFetch(method, segments, body) → Promise<Response>, Bearer-authenticated
    //   writeConsentRecord(obj)
    //   setAuth(state, username, token)  replace the whole auth triple
    //   setToken(token)                  set the token alone — the import below
    //                                    needs it, and a failed import rolls it back
    //   fireStateChange()
    // Returns accept(): Promise that resolves once the account is bound.
    globalThis.createSyncAccept = function (deps) {
        var apiFetch = deps.apiFetch;
        var writeConsentRecord = deps.writeConsentRecord;
        var setAuth = deps.setAuth;
        var setToken = deps.setToken;
        var fireStateChange = deps.fireStateChange;
        var Sections = globalThis.SyncSections;

        return function accept() {
            return apiFetch('POST', ['accounts']).then(function (res) {
                if (!res.ok) { throw new Error('POST /accounts failed: ' + res.status); }
                return res.json();
            }).then(function (body) {
                var username = body.username;
                var token = body.token;
                // Set the token before the import below — that request is now authenticated.
                setToken(token);

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
                    setAuth('accepted', username, token);
                    // Carry the secret in the fragment so the link itself is the credential.
                    history.replaceState(null, '', '/wander/' + username + '#t=' + token);
                    fireStateChange();
                }).catch(function (e) {
                    setToken(null);   // roll back partial auth state if the import failed
                    throw e;
                });
            });
        };
    };
}());
