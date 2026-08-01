// Durable outbox + flush pump for cloud-backup mutations. Owns the
// walk_sync_outbox queue and a single-flight flush worker with exponential
// backoff. It holds no account/consent state of its own — the host injects an
// authenticated apiFetch and a getUsername() accessor (null ⇒ not syncable yet),
// so the worker reads nothing of sync.js's internals.
//
// Load order: <script src="sync-flush.js"> BEFORE sync.js — sync.js's IIFE builds
// the worker at load time (to wire the 'online' listener to it).

(function () {
    'use strict';

    var OUTBOX_KEY = 'walk_sync_outbox';
    var BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 60000];

    // The outbox rides on storage.js's readStoredArray/writeStoredArray so the
    // parse-or-default + quota-aware write contract lives in exactly one place
    // (the pattern sync-sections.js already uses for the walk_* keys). Resolved
    // off globalThis at call time because storage.js loads AFTER this script —
    // both are defined well before any outbox op runs. writeStoredArray's quota
    // handler frees space by trimming old visit geometry, so a full localStorage
    // no longer silently drops queued mutations here either. Returns the boolean
    // so callers can skip scheduleFlush when the durable queue write failed —
    // otherwise flush would run against a queue that never accepted the entry.
    function parseOutbox() {
        return globalThis.readStoredArray(OUTBOX_KEY);
    }

    function saveOutbox(entries) {
        return globalThis.writeStoredArray(OUTBOX_KEY, entries);
    }

    function clearOutbox() {
        localStorage.removeItem(OUTBOX_KEY);
    }

    function nextBackoff(current) {
        for (var i = 0; i < BACKOFF_STEPS.length; i++) {
            if (current < BACKOFF_STEPS[i]) { return BACKOFF_STEPS[i]; }
        }
        return BACKOFF_STEPS[BACKOFF_STEPS.length - 1];
    }

    // deps:
    //   apiFetch(method, segments, body) → Promise<Response>  (Bearer token; encodes
    //                                                          each path segment)
    //   getUsername() → string | null                         (null when not accepted)
    function createSyncFlushWorker(deps) {
        var apiFetch = deps.apiFetch;
        var getUsername = deps.getUsername;

        var _flushing = false;
        var _backoffMs = 0;
        var _backoffTimer = null;
        var _flushWaiters = [];   // resolve callbacks awaiting a fully-drained outbox
        var _destroyed = false;   // retired instance — see destroy()
        // Auth hard-stop (401/403): leave the queue intact, stop scheduling, and
        // toast once until the host rebinds consent and calls resume().
        var _authBlocked = false;
        var _authNotified = false;

        // The pump's only entry point: run flushHead after delayMs (0 ⇒ next
        // microtask). Every caller — enqueue, the post-request reschedule, the
        // online handler, the host's load-time nudge — goes through this, so
        // there is one place where a flush can start. An auth block freezes the
        // pump without dropping entries (audit #6223).
        function scheduleFlush(delayMs) {
            if (_destroyed || _authBlocked) { return; }
            if (_backoffTimer !== null) { return; }
            if (delayMs > 0) {
                _backoffTimer = setTimeout(function () {
                    _backoffTimer = null;
                    flushHead();
                }, delayMs);
            } else {
                // Use a microtask so callers finish before we start
                Promise.resolve().then(flushHead);
            }
        }

        // Clear an auth hard-stop and re-arm the pump. Called by the host after
        // consent is re-bound (fresh token / re-init to accepted); also the
        // right entry for a load-time drain once auth is known good.
        function resume() {
            if (_destroyed) { return; }
            _authBlocked = false;
            _authNotified = false;
            scheduleFlush(0);
        }

        // Resolve any pending whenDrained() promises once the queue is fully
        // drained and no request is in flight. The event-based completion signal
        // that replaces the old 10 ms polling loop.
        function settleFlushWaiters() {
            if (_flushing) { return; }
            if (parseOutbox().length > 0) { return; }
            var waiters = _flushWaiters;
            _flushWaiters = [];
            for (var i = 0; i < waiters.length; i++) { waiters[i](); }
        }

        // Drop the head entry just processed (re-reading the outbox so a concurrent
        // enqueue during the in-flight request is preserved), persist, and either
        // reschedule for the next entry or signal flush completion.
        function consumeOutboxHead() {
            var remaining = parseOutbox();
            remaining.shift();
            // If the head drop can't be persisted, localStorage still holds the
            // processed entry. Back off rather than scheduleFlush(0): a tight
            // retry would re-send the same entry forever (HTTP succeeds, shift
            // fails, re-arm) and OOM the page. PUT/DELETE are idempotent so a
            // later attempt is safe; waiters stay pending until the drop lands.
            if (!saveOutbox(remaining)) {
                _backoffMs = nextBackoff(_backoffMs);
                scheduleFlush(_backoffMs);
                return;
            }
            if (remaining.length > 0) {
                scheduleFlush(0);
            }
            settleFlushWaiters();
        }

        // Send exactly ONE entry — the head of the queue — and reschedule for the
        // next one on completion. Named for that: it is not "flush the outbox",
        // and calling it twice concurrently is a no-op by the _flushing guard.
        function flushHead() {
            if (_destroyed || _flushing || _authBlocked) { return; }
            var username = getUsername();
            if (!username) { settleFlushWaiters(); return; }
            var outbox = parseOutbox();
            if (outbox.length === 0) { settleFlushWaiters(); return; }

            _flushing = true;
            var entry = outbox[0];
            // Segments, not a concatenated path: apiFetch encodes each one. An
            // entry.id can carry user-supplied text (importVisits takes ids
            // verbatim from an uploaded backup file), and a raw '/' or '..' in
            // it would redirect this authenticated write to another endpoint.
            var segments = [username, entry.section, entry.id];
            var method = entry.op === 'delete' ? 'DELETE' : 'PUT';
            var body = entry.op === 'delete' ? undefined : entry.data;

            apiFetch(method, segments, body).then(function (res) {
                _flushing = false;

                // Reset the ladder only on outcomes that aren't a server fault:
                // success (2xx), server-directed throttling (429), and 4xx drops.
                // The 5xx/unexpected branch must NOT reset — it reads the
                // accumulated value so the ladder actually escalates. Resetting
                // here (the old bug) made every 5xx call nextBackoff(0) → a
                // constant ~1s retry that hammered a down server forever.
                if (res.status >= 200 && res.status < 300) {
                    _backoffMs = 0;
                    consumeOutboxHead();
                    return;
                }

                if (res.status === 429) {
                    _backoffMs = 0;
                    var retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
                    scheduleFlush(retryAfter * 1000);
                    return;
                }

                // 401/403: wrong/missing token or deleted account — not an
                // entry-level reject. Dropping the whole durable queue would
                // silently diverge cloud from local with only a console.warn
                // (audit #6223). Hard-stop: keep the head, toast once, freeze
                // the pump until resume() after consent is re-bound.
                if (res.status === 401 || res.status === 403) {
                    _backoffMs = 0;
                    _authBlocked = true;
                    console.warn('[ExplorerSync] Auth failure (' + res.status + '); pausing outbox flush', entry);
                    if (!_authNotified) {
                        _authNotified = true;
                        if (typeof globalThis.showError === 'function') {
                            globalThis.showError(
                                'Cloud backup authorization failed. Your walks are safe locally — reopen your backup link to reconnect.'
                            );
                        }
                    }
                    return;
                }

                // Other 4xx (400 validation, 404 unknown section/id, …): the
                // entry itself is unrecoverable — drop it and continue.
                if (res.status >= 400 && res.status < 500) {
                    _backoffMs = 0;
                    console.warn('[ExplorerSync] Dropping outbox entry due to ' + res.status, entry);
                    consumeOutboxHead();
                    return;
                }

                // 5xx or unexpected — escalate the exponential backoff ladder
                // (1s→2s→…→60s) off the accumulated value.
                _backoffMs = nextBackoff(_backoffMs);
                scheduleFlush(_backoffMs);

            }).catch(function () {
                _flushing = false;
                _backoffMs = nextBackoff(_backoffMs);
                scheduleFlush(_backoffMs);
            });
        }

        // Append a mutation and start the pump. Re-reads the persisted queue so a
        // concurrent flush's shift() isn't clobbered. Skip the pump when the
        // durable write fails — flushing a mutation that never landed would only
        // waste requests, and the next successful enqueue re-drives the pump.
        function enqueue(entry) {
            var outbox = parseOutbox();
            outbox.push(entry);
            if (!saveOutbox(outbox)) return;
            scheduleFlush(0);
        }

        // Resolves when the outbox is fully drained. It does NOT itself drain the
        // queue — the pump does that; this only nudges it and then waits, which
        // is why it is named for the condition rather than the action.
        // Completion is signalled through settleFlushWaiters rather than polled.
        function whenDrained() {
            return new Promise(function (resolve) {
                if (_destroyed || (!_flushing && parseOutbox().length === 0)) {
                    resolve();
                    return;
                }
                _flushWaiters.push(resolve);
                flushHead();
            });
        }

        // Back online — cancel any pending backoff timer, reset the backoff, and
        // retry immediately. Auth blocks stay in force: connectivity does not
        // repair a bad token; only resume() after rebind does.
        function onOnline() {
            if (_authBlocked) { return; }
            if (_backoffTimer !== null) {
                clearTimeout(_backoffTimer);
                _backoffTimer = null;
            }
            _backoffMs = 0;
            scheduleFlush(0);
        }

        // Retire this worker: cancel a pending backoff retry and refuse any
        // further scheduling, so an in-flight request that resolves later can't
        // resurrect it. Production has exactly one worker for the page's lifetime
        // and never calls this; the test harness re-runs sync.js's IIFE on one
        // shared window, and without it every dead instance keeps a live backoff
        // timer aimed at the *shared* walk_sync_outbox key — consuming entries out
        // from under whichever test is running when the timer fires. Pending
        // whenDrained() waiters are resolved rather than dropped so nothing hangs.
        function destroy() {
            if (_backoffTimer !== null) {
                clearTimeout(_backoffTimer);
                _backoffTimer = null;
            }
            _destroyed = true;
            var waiters = _flushWaiters;
            _flushWaiters = [];
            for (var i = 0; i < waiters.length; i++) { waiters[i](); }
        }

        return {
            enqueue: enqueue,
            whenDrained: whenDrained,
            onOnline: onOnline,
            scheduleFlush: scheduleFlush,
            resume: resume,
            destroy: destroy,
            peek: parseOutbox,
            length: function () { return parseOutbox().length; },
            clear: clearOutbox
        };
    }

    globalThis.createSyncFlushWorker = createSyncFlushWorker;

}());
