// @vitest-environment jsdom
/**
 * Pins that `localStorage` in a test is jsdom's, not the host Node's.
 *
 * Node ships Web Storage as a real `globalThis.localStorage` — behind
 * --experimental-webstorage on 24, on by default from 25. When it exists it
 * wins over the jsdom global vitest installs, and the suite silently stops
 * testing the browser storage the app actually uses: `Storage.prototype`
 * spies never fire (so every quota-recovery test passes vacuously), and on
 * Node 25 with no --localstorage-file even `localStorage.clear()` throws.
 * Measured on this repo under `node --experimental-webstorage`: 8 failures
 * across storage.test.js, sync-restore.test.js and sync-sections.test.js.
 *
 * tests/setup/jsdom-storage.js rebinds it per test file; this is the guard
 * that fails if that setup file is dropped from vitest.config.js or stops
 * working on a future Node. Without it the breakage is invisible until the
 * day the host Node changes.
 */

import { describe, test, expect } from 'vitest';

describe('localStorage binding', () => {
    test('globalThis.localStorage IS window.localStorage', () => {
        expect(globalThis.localStorage).toBe(window.localStorage);
        expect(globalThis.sessionStorage).toBe(window.sessionStorage);
    });

    test('it is a jsdom Storage, so Storage.prototype spies reach it', () => {
        // The quota tests spy on Storage.prototype.setItem and expect the spy
        // to intercept every localStorage write. That only holds while the
        // bound object inherits from the same Storage the spy patches.
        expect(Object.getPrototypeOf(globalThis.localStorage)).toBe(Storage.prototype);
        expect(globalThis.localStorage).toBeInstanceOf(Storage);
    });

    test('the full Storage surface the harness calls is present', () => {
        // sync-harness.js and synced-mirror.js call these bare. Node 25's
        // built-in has no clear(), which is the exact crash the harness hits.
        for (const method of ['clear', 'getItem', 'setItem', 'removeItem', 'key']) {
            expect(typeof globalThis.localStorage[method]).toBe('function');
        }
    });

    test('a write through the global is readable through window (one store)', () => {
        globalThis.localStorage.setItem('walk_binding_probe', 'x');
        expect(window.localStorage.getItem('walk_binding_probe')).toBe('x');
        globalThis.localStorage.clear();
        expect(window.localStorage.getItem('walk_binding_probe')).toBeNull();
    });
});
