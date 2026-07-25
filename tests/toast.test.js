/**
 * Tests for toast.js — showToast + showError/showSuccess/showWarning (audit #1266).
 *
 * Loading: toast.js is a non-module browser script; helpers/load.js evaluates it
 * in the current realm and its explicit globalThis assignments expose the helpers.
 *
 * The #notification element is replaced with a recording fake (via a document.getElementById
 * stub) so we capture the EXACT raw style writes / classList toggles / textContent
 * in order — independent of jsdom's color normalization (it rewrites #hex → rgb()).
 * That gives precise per-variant DOM-mutation-set parity with the original three
 * functions. Fake timers pin the hide-timeout duration per variant.
 *
 * Mutation-proof: each variant pins its OWN palette + timeout, so corrupting one
 * variant's config (e.g. swapping the success color into the warning entry) turns
 * only that variant's tests RED.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('toast');
});

// A fake #notification element that records every mutation in order.
function makeFakeError() {
    const writes = [];      // ordered [prop, value] style writes
    const classOps = [];    // ordered ['add'|'remove', name] classList ops
    const classSet = new Set();
    const styleTarget = {};
    const style = new Proxy(styleTarget, {
        set(t, prop, value) { writes.push([prop, value]); t[prop] = value; return true; },
        get(t, prop) { return t[prop]; },
    });
    return {
        textContent: undefined,
        style,
        classList: {
            add(name) { classOps.push(['add', name]); classSet.add(name); },
            remove(name) { classOps.push(['remove', name]); classSet.delete(name); },
            contains(name) { return classSet.has(name); },
        },
        _writes: writes,
        _classOps: classOps,
        _active: () => classSet.has('active'),
    };
}

let fakeEl;
let origGetById;

beforeEach(() => {
    vi.useFakeTimers();
    fakeEl = makeFakeError();
    origGetById = document.getElementById;
    document.getElementById = (id) => (id === 'notification' ? fakeEl : null);
});

afterEach(() => {
    document.getElementById = origGetById;
    vi.useRealTimers();
});

// Last value written for a style prop (undefined if never written).
const finalStyle = (el, prop) => {
    const hit = [...el._writes].reverse().find(([p]) => p === prop);
    return hit ? hit[1] : undefined;
};
const wroteProp = (el, prop) => el._writes.some(([p]) => p === prop);

describe('showError', () => {
    test('show: textContent + color/background "" + active, NO borderColor write', () => {
        globalThis.showError('boom');
        expect(fakeEl.textContent).toBe('boom');
        expect(finalStyle(fakeEl, 'color')).toBe('');
        expect(finalStyle(fakeEl, 'background')).toBe('');
        expect(wroteProp(fakeEl, 'borderColor')).toBe(false);
        expect(fakeEl._active()).toBe(true);
    });

    test('hide after exactly 5000ms; resets NO styles', () => {
        globalThis.showError('boom');
        const writesAtShow = fakeEl._writes.length;
        vi.advanceTimersByTime(4999);
        expect(fakeEl._active()).toBe(true);            // duration boundary
        vi.advanceTimersByTime(1);
        expect(fakeEl._active()).toBe(false);
        expect(fakeEl._writes.length).toBe(writesAtShow); // no reset writes
    });

    test('full ordered mutation set (show; hide removes active only)', () => {
        globalThis.showError('e');
        vi.advanceTimersByTime(5000);
        expect(fakeEl._writes).toEqual([['color', ''], ['background', '']]);
        expect(fakeEl._classOps).toEqual([['add', 'active'], ['remove', 'active']]);
    });
});

describe('showSuccess', () => {
    test('show: green palette across all three style props + active', () => {
        globalThis.showSuccess('yay');
        expect(fakeEl.textContent).toBe('yay');
        expect(finalStyle(fakeEl, 'color')).toBe('#86efac');
        expect(finalStyle(fakeEl, 'background')).toBe('rgba(34, 197, 94, 0.15)');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('rgba(34, 197, 94, 0.3)');
        expect(fakeEl._active()).toBe(true);
    });

    test('hide after exactly 4000ms; resets all three styles to ""', () => {
        globalThis.showSuccess('yay');
        vi.advanceTimersByTime(3999);
        expect(fakeEl._active()).toBe(true);            // duration boundary
        vi.advanceTimersByTime(1);
        expect(fakeEl._active()).toBe(false);
        expect(finalStyle(fakeEl, 'color')).toBe('');
        expect(finalStyle(fakeEl, 'background')).toBe('');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('');
    });

    test('full ordered mutation set (show palette then reset all)', () => {
        globalThis.showSuccess('y');
        vi.advanceTimersByTime(4000);
        expect(fakeEl._writes).toEqual([
            ['color', '#86efac'],
            ['background', 'rgba(34, 197, 94, 0.15)'],
            ['borderColor', 'rgba(34, 197, 94, 0.3)'],
            ['color', ''],
            ['background', ''],
            ['borderColor', ''],
        ]);
        expect(fakeEl._classOps).toEqual([['add', 'active'], ['remove', 'active']]);
    });
});

describe('showWarning', () => {
    test('show: amber palette across all three style props + active', () => {
        globalThis.showWarning('careful');
        expect(fakeEl.textContent).toBe('careful');
        expect(finalStyle(fakeEl, 'color')).toBe('#fcd34d');
        expect(finalStyle(fakeEl, 'background')).toBe('rgba(245, 158, 11, 0.15)');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('rgba(245, 158, 11, 0.3)');
        expect(fakeEl._active()).toBe(true);
    });

    test('hide after exactly 5000ms; resets all three styles to ""', () => {
        globalThis.showWarning('careful');
        vi.advanceTimersByTime(4999);
        expect(fakeEl._active()).toBe(true);            // duration boundary
        vi.advanceTimersByTime(1);
        expect(fakeEl._active()).toBe(false);
        expect(finalStyle(fakeEl, 'color')).toBe('');
        expect(finalStyle(fakeEl, 'background')).toBe('');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('');
    });

    test('full ordered mutation set (show palette then reset all)', () => {
        globalThis.showWarning('w');
        vi.advanceTimersByTime(5000);
        expect(fakeEl._writes).toEqual([
            ['color', '#fcd34d'],
            ['background', 'rgba(245, 158, 11, 0.15)'],
            ['borderColor', 'rgba(245, 158, 11, 0.3)'],
            ['color', ''],
            ['background', ''],
            ['borderColor', ''],
        ]);
        expect(fakeEl._classOps).toEqual([['add', 'active'], ['remove', 'active']]);
    });
});

describe('showToast', () => {
    test('defaults to the error variant when opts omitted', () => {
        globalThis.showToast('default');
        expect(fakeEl.textContent).toBe('default');
        expect(finalStyle(fakeEl, 'color')).toBe('');
        expect(finalStyle(fakeEl, 'background')).toBe('');
        expect(wroteProp(fakeEl, 'borderColor')).toBe(false);
        expect(fakeEl._active()).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(fakeEl._active()).toBe(false);
    });

    test('explicit success variant matches the showSuccess palette', () => {
        globalThis.showToast('s', { variant: 'success' });
        expect(finalStyle(fakeEl, 'color')).toBe('#86efac');
        expect(finalStyle(fakeEl, 'background')).toBe('rgba(34, 197, 94, 0.15)');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('rgba(34, 197, 94, 0.3)');
    });

    test('explicit warning variant matches the showWarning palette', () => {
        globalThis.showToast('w', { variant: 'warning' });
        expect(finalStyle(fakeEl, 'color')).toBe('#fcd34d');
        expect(finalStyle(fakeEl, 'background')).toBe('rgba(245, 158, 11, 0.15)');
        expect(finalStyle(fakeEl, 'borderColor')).toBe('rgba(245, 158, 11, 0.3)');
    });
});
