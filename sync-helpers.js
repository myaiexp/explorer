// Persist-and-mirror wrappers — write a synced collection to localStorage and
// replicate the change to the cloud outbox in one step.

// WanderSync (sync.js) and writeStoredArray (storage.js) are loaded before this
// in index.html's fixed defer order, so they are always defined by call time.

// Prompt for cloud-backup consent the first time an anonymous user saves anything.
function maybeRequestConsent() {
    if (WanderSync.getState().state === 'anonymous') {
        WanderSync.requestConsent();
    }
}

// Persist a synced collection and mirror the change to the cloud outbox in one
// step. writeStoredArray (storage.js) owns the localStorage write; these keep the
// persist-and-mirror invariant in one place so a new call site can't save locally
// while forgetting to replicate (the bug class fixed in #2065). Every mutation of
// the four synced collections (savedLocations, favorites, history, visits) goes
// through one of these — except importVisits' batch put (visits-io.js), which
// writes once and mirrors each row in a loop.
//
// Gate the outbox mirror on a durable local write: when writeStoredArray returns
// false (quota exhausted, already toasted), mutate must not run — otherwise the
// cloud outbox would claim a put/delete that localStorage never accepted.
// Returns whether the local write (and therefore the mirror) happened.
function syncedPut(key, arr, section, id, data) {
    if (!writeStoredArray(key, arr)) return false;
    WanderSync.mutate(section, 'put', id, data);
    return true;
}

function syncedDelete(key, arr, section, id) {
    if (!writeStoredArray(key, arr)) return false;
    WanderSync.mutate(section, 'delete', id);
    return true;
}

globalThis.maybeRequestConsent = maybeRequestConsent;
globalThis.syncedPut = syncedPut;
globalThis.syncedDelete = syncedDelete;
