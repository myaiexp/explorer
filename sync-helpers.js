// Persist-and-mirror wrappers — write a synced collection to localStorage and
// replicate the change to the cloud outbox in one step.

// ExplorerSync (sync.js) and writeStoredArray (storage.js) are loaded before this
// in index.html's fixed defer order, so they are always defined by call time.

// Prompt for cloud-backup consent the first time an anonymous user saves anything.
function maybeRequestConsent() {
    if (ExplorerSync.getState().state === 'anonymous') {
        ExplorerSync.requestConsent();
    }
}

// Persist a synced collection and mirror the change to the cloud outbox in one
// step. writeStoredArray (storage.js) owns the localStorage write; these keep the
// persist-and-mirror invariant in one place so a new call site can't save locally
// while forgetting to replicate (the bug class fixed in #2065). Every mutation of
// the four synced collections (savedLocations, favorites, history, visits) goes
// through one of these — except importVisits' batch put (visits-io.js), which
// writes once and mirrors each row in a loop.
function syncedPut(key, arr, section, id, data) {
    writeStoredArray(key, arr);
    ExplorerSync.mutate(section, 'put', id, data);
}

function syncedDelete(key, arr, section, id) {
    writeStoredArray(key, arr);
    ExplorerSync.mutate(section, 'delete', id);
}

globalThis.maybeRequestConsent = maybeRequestConsent;
globalThis.syncedPut = syncedPut;
globalThis.syncedDelete = syncedDelete;
