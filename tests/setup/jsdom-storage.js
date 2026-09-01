// Force localStorage/sessionStorage to be jsdom's, not the host Node's.
//
// Node ships Web Storage as a real `globalThis.localStorage` — behind
// --experimental-webstorage on 24, on by default from 25. It is a getter-only
// own accessor on the Node global, so vitest's jsdom environment cannot assign
// its own over it and the ambient one wins. The suite then stops testing the
// browser storage the app uses: Storage.prototype spies never intercept a write
// (so every quota-recovery test passes vacuously), and on Node 25 with no
// --localstorage-file the getter itself throws, taking the bare
// localStorage.clear() in tests/helpers/sync-harness.js with it. Measured on
// this repo under `node --experimental-webstorage`: 8 failures across
// storage.test.js, sync-restore.test.js and sync-sections.test.js.
//
// Registered as a vitest setupFile, so it runs per test file once the
// environment is up. tests/localstorage-binding.test.js is the guard that goes
// red if this is dropped from vitest.config.js or stops working on a future Node.

import { JSDOM } from 'jsdom';

// True when the binding is already correct — the normal case on a Node with no
// built-in Web Storage, where jsdom's own global survived. Reading the accessor
// can itself throw (Node 25, no --localstorage-file), which is also a "not
// jsdom's".
function bindingIsJsdom() {
    try {
        return globalThis.localStorage instanceof globalThis.Storage;
    } catch {
        return false;
    }
}

// Only rebind when the ambient global has actually shadowed jsdom's, so a host
// Node without Web Storage runs byte-identically to before this file existed.
if (!bindingIsJsdom()) {
    // The environment's own jsdom window is not reachable from here (vitest
    // aliases `window` to globalThis), so take a window of our own. Storage
    // travels with it: the tests spy on Storage.prototype, which only reaches
    // the store while the class and the instance come from one realm. `url`
    // matches vitest's jsdom default — storage is origin-scoped, and an opaque
    // origin makes jsdom refuse localStorage outright.
    const { window } = new JSDOM('', { url: 'http://localhost:3000/' });
    for (const key of ['Storage', 'localStorage', 'sessionStorage']) {
        Object.defineProperty(globalThis, key, {
            value: window[key],
            writable: true,
            configurable: true,
            enumerable: true,
        });
    }
}
