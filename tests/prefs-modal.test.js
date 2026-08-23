/**
 * Tests for prefs-modal.js — open/close, Escape, swatch selection, and
 * missing-node safety (finding #7782). overflow-menu.test.js pins the same
 * missing-node class for the header menu; export.test.js covers the FIT-modal
 * Escape twin. Collaborators on map-view.js (ROUTE_COLORS / getRouteColor /
 * setRouteColor / applyRouteColor) are faked — prefs-modal is not a SCRIPT_DEPS
 * key for the same reason map-view isn't: route-view tests stub those globals.
 *
 * prefs-modal.js registers a document keydown listener at evaluate time, so we
 * load it once in beforeAll — a per-test reload would stack listeners.
 */
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const COLORS = [
    { name: 'Coral', hex: '#E66100' },
    { name: 'Sky', hex: '#56B4E9' },
];

beforeAll(() => {
    loadScripts('prefs-modal');
});

function mount() {
    document.body.innerHTML =
        '<div id="prefsModal" class="modal-backdrop">' +
            '<div class="swatch-grid" id="routeColorSwatches"></div>' +
        '</div>';
}

function modal() {
    return document.getElementById('prefsModal');
}

function isOpen() {
    return modal().classList.contains('active');
}

function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

beforeEach(() => {
    globalThis._routeColor = COLORS[0].hex;
    globalThis.ROUTE_COLORS = COLORS;
    globalThis.getRouteColor = () => globalThis._routeColor;
    globalThis.setRouteColor = vi.fn((hex) => { globalThis._routeColor = hex; });
    globalThis.applyRouteColor = vi.fn();
    mount();
});

describe('open/close', () => {
    test('open adds .active; close removes it', () => {
        expect(isOpen()).toBe(false);
        openPreferencesModal();
        expect(isOpen()).toBe(true);
        closePreferencesModal();
        expect(isOpen()).toBe(false);
    });
});

describe('Escape', () => {
    test('closes the modal only when it is open', () => {
        expect(isOpen()).toBe(false);
        pressEscape();
        expect(isOpen()).toBe(false);

        openPreferencesModal();
        expect(isOpen()).toBe(true);
        pressEscape();
        expect(isOpen()).toBe(false);

        pressEscape();
        expect(isOpen()).toBe(false);
    });

    test('a non-Escape key does not close an open modal', () => {
        openPreferencesModal();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(isOpen()).toBe(true);
    });
});

describe('swatch grid', () => {
    test('open renders a swatch per color and marks the active one', () => {
        openPreferencesModal();
        const buttons = [...document.querySelectorAll('#routeColorSwatches button.swatch')];
        expect(buttons).toHaveLength(COLORS.length);
        expect(buttons.map((b) => b.title)).toEqual(COLORS.map((c) => c.name));
        expect(buttons[0].classList.contains('active')).toBe(true);
        expect(buttons[1].classList.contains('active')).toBe(false);
    });

    test('clicking a swatch calls setRouteColor/applyRouteColor and marks .active', () => {
        openPreferencesModal();
        const sky = document.querySelector('#routeColorSwatches button[title="Sky"]');
        sky.click();

        expect(setRouteColor).toHaveBeenCalledWith('#56B4E9');
        expect(applyRouteColor).toHaveBeenCalled();

        const buttons = [...document.querySelectorAll('#routeColorSwatches button.swatch')];
        expect(buttons[0].classList.contains('active')).toBe(false);
        expect(buttons[1].classList.contains('active')).toBe(true);
    });
});

describe('missing nodes do not throw', () => {
    test('open, close, and Escape are safe with no #prefsModal', () => {
        document.body.innerHTML = '<div id="other"></div>';
        expect(() => openPreferencesModal()).not.toThrow();
        expect(() => closePreferencesModal()).not.toThrow();
        expect(() => pressEscape()).not.toThrow();
    });

    test('open and Escape are safe when only the swatch grid exists', () => {
        document.body.innerHTML = '<div class="swatch-grid" id="routeColorSwatches"></div>';
        expect(() => openPreferencesModal()).not.toThrow();
        expect(() => pressEscape()).not.toThrow();
        expect(document.querySelectorAll('#routeColorSwatches button.swatch')).toHaveLength(COLORS.length);
    });

    test('Escape is safe when only the modal exists', () => {
        document.body.innerHTML = '<div id="prefsModal" class="modal-backdrop active"></div>';
        expect(() => pressEscape()).not.toThrow();
        expect(isOpen()).toBe(false);
    });
});
