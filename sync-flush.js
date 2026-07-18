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
    // no longer silently drops queued mutations here either.
    function parseOutbox() {
        return globalThis.readStoredArray(OUTBOX_KEY);
    }

    function saveOutbox(entries) {
        globalThis.writeStoredArray(OUTBOX_KEY, entries);
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
    //   apiFetch(method, path, body) → Promise<Response>  (carries the Bearer token)
    //   getUsername() → string | null                     (null when not accepted)
    function createSyncFlushWorker(deps) {
        var apiFetch = deps.apiFetch;
        var getUsername = deps.getUsername;

        var _flushing = false;
        var _backoffMs = 0;
        var _backoffTimer = null;
        var _flushWaiters = [];   // resolve callbacks awaiting a fully-drained outbox

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

        // Resolve any pending flush() promises once the queue is fully drained and
        // no flush is in flight. The event-based completion signal that replaces
        // the old 10 ms polling loop.
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
            saveOutbox(remaining);
            if (remaining.length > 0) {
                scheduleFlush(0);
            }
            settleFlushWaiters();
        }

        function doFlush() {
            if (_flushing) { return; }
            var username = getUsername();
            if (!username) { settleFlushWaiters(); return; }
            var outbox = parseOutbox();
            if (outbox.length === 0) { settleFlushWaiters(); return; }

            _flushing = true;
            var entry = outbox[0];
            var path = '/' + username + '/' + entry.section + '/' + entry.id;
            var method = entry.op === 'delete' ? 'DELETE' : 'PUT';
            var body = entry.op === 'delete' ? undefined : entry.data;

            apiFetch(method, path, body).then(function (res) {
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

        // Append a mutation and kick the pump. Re-reads the persisted queue so a
        // concurrent flush's shift() isn't clobbered.
        function enqueue(entry) {
            var outbox = parseOutbox();
            outbox.push(entry);
            saveOutbox(outbox);
            scheduleFlush(0);
        }

        // Resolves when the outbox is fully drained. Completion is signalled
        // through settleFlushWaiters rather than polled.
        function flush() {
            return new Promise(function (resolve) {
                if (!_flushing && parseOutbox().length === 0) {
                    resolve();
                    return;
                }
                _flushWaiters.push(resolve);
                doFlush();
            });
        }

        // Back online — cancel any pending backoff timer, reset the backoff, and
        // retry immediately.
        function onOnline() {
            if (_backoffTimer !== null) {
                clearTimeout(_backoffTimer);
                _backoffTimer = null;
            }
            _backoffMs = 0;
            scheduleFlush(0);
        }

        // Nudge the pump once — used on page load to drain a queue that survived a
        // restart (a mutation persisted to the outbox but not flushed before the
        // tab closed). Fresh worker instance, so there's no backoff state to reset
        // (unlike onOnline); doFlush's own guards no-op when not accepted or empty.
        function kick() {
            scheduleFlush(0);
        }

        return {
            enqueue: enqueue,
            flush: flush,
            onOnline: onOnline,
            kick: kick,
            peek: parseOutbox,
            length: function () { return parseOutbox().length; },
            clear: clearOutbox
        };
    }

    globalThis.createSyncFlushWorker = createSyncFlushWorker;

}());
