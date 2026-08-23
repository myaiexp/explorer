/**
 * Tests for overflow-menu.js — toggle, click-outside dismiss, and missing-node
 * safety (finding #7581). cloud-backup-ui.test.js stubs closeOverflowMenuIfOpen;
 * this is the suite that header claimed existed.
 *
 * overflow-menu.js registers a document click listener at evaluate time, so we
 * load it once in beforeAll — a per-test reload would stack listeners.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('overflow-menu');
});

function mount() {
    document.body.innerHTML =
        '<button type="button" id="overflowBtn">More</button>' +
        '<div id="overflowMenu">' +
            '<button type="button" id="copyBackupLinkBtn">Copy backup link</button>' +
        '</div>';
}

function menu() {
    return document.getElementById('overflowMenu');
}
function btn() {
    return document.getElementById('overflowBtn');
}
function isOpen() {
    return menu().classList.contains('open');
}

beforeEach(() => {
    mount();
});

describe('toggleOverflowMenu', () => {
    test('opens a closed menu and closes an open one', () => {
        expect(isOpen()).toBe(false);
        toggleOverflowMenu();
        expect(isOpen()).toBe(true);
        toggleOverflowMenu();
        expect(isOpen()).toBe(false);
    });
});

describe('closeOverflowMenuIfOpen', () => {
    test('is a no-op when the menu is already closed', () => {
        expect(isOpen()).toBe(false);
        closeOverflowMenuIfOpen();
        expect(isOpen()).toBe(false);
    });

    test('removes .open when the menu is open', () => {
        menu().classList.add('open');
        closeOverflowMenuIfOpen();
        expect(isOpen()).toBe(false);
    });
});

describe('click-outside dismiss', () => {
    test('a click outside the menu and button closes an open menu', () => {
        menu().classList.add('open');
        document.body.click();
        expect(isOpen()).toBe(false);
    });

    test('a click inside the menu does not close it', () => {
        menu().classList.add('open');
        document.getElementById('copyBackupLinkBtn').click();
        expect(isOpen()).toBe(true);
    });

    test('a click on the overflow button does not close it (toggle owns that)', () => {
        menu().classList.add('open');
        btn().click();
        expect(isOpen()).toBe(true);
    });
});

describe('missing nodes do not throw', () => {
    test('toggle, close, and a document click are safe with no menu or button', () => {
        document.body.innerHTML = '<div id="other"></div>';
        expect(() => toggleOverflowMenu()).not.toThrow();
        expect(() => closeOverflowMenuIfOpen()).not.toThrow();
        expect(() => document.body.click()).not.toThrow();
        expect(() => document.getElementById('other').click()).not.toThrow();
    });

    test('a document click is safe when only the button exists', () => {
        document.body.innerHTML = '<button type="button" id="overflowBtn">More</button>';
        expect(() => document.body.click()).not.toThrow();
        expect(() => btn().click()).not.toThrow();
    });

    test('a document click is safe when only the menu exists', () => {
        document.body.innerHTML = '<div id="overflowMenu" class="open"></div>';
        expect(() => document.body.click()).not.toThrow();
    });
});
