/**
 * Shared syncedPut/syncedDelete stand-ins for CRUD suites (history, favorites,
 * visited-sync, …). Real localStorage write + call-recording for the cloud-mirror
 * half, matching sync-helpers.js's write-then-mutate contract (mutate is a no-op
 * for anonymous users). Every suite that used to paste this body gets the same
 * harness so a contract change lands in one place.
 *
 * Call once per beforeEach so each test gets a fresh call log and writeOk flag.
 *
 * @param {{ recordPutData?: boolean }} [opts]
 *   recordPutData — when true, putCalls entries include `data` (visited-sync
 *   needs the put payload; history/favorites only assert section + id).
 * @returns {{ putCalls: object[], deleteCalls: object[], setWriteOk: (ok: boolean) => void }}
 */
export function installSyncedMirrorStubs(opts = {}) {
  const putCalls = [];
  const deleteCalls = [];
  let writeOk = true;

  globalThis.syncedPut = (key, arr, section, id, data) => {
    if (!writeOk) return false;
    localStorage.setItem(key, JSON.stringify(arr));
    putCalls.push(opts.recordPutData ? { section, id, data } : { section, id });
    return true;
  };
  globalThis.syncedDelete = (key, arr, section, id) => {
    if (!writeOk) return false;
    localStorage.setItem(key, JSON.stringify(arr));
    deleteCalls.push({ section, id });
    return true;
  };

  return {
    putCalls,
    deleteCalls,
    /** Force the next put/delete to simulate a hard-quota writeStoredArray failure. */
    setWriteOk(ok) { writeOk = !!ok; },
  };
}
