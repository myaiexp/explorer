// @vitest-environment jsdom
/**
 * Tests for form-controls.js — trip-mode change delegates to syncDistanceLabel
 * (finding #7316); stepNumInput clamps; Enter / Ctrl+Enter generate (finding #7588).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const FORM_HTML = `
  <input id="location">
  <input type="number" id="minDistance" min="0" max="100" step="0.5" value="0">
  <input type="number" id="maxDistance" min="0.5" max="100" step="0.5" value="5">
  <input type="number" id="unbounded">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <label id="distanceLabel">Round-trip distance (km)</label>
`;

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    globalThis.generateDestination = () => {};
    globalThis.syncDistanceLabel = vi.fn();
    loadScripts('form-controls');
});

describe('trip-mode change', () => {
    test('calls syncDistanceLabel instead of writing the label itself', () => {
        document.getElementById('oneWay').checked = true;
        document.getElementById('oneWay').dispatchEvent(new Event('change'));
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
        expect(document.getElementById('distanceLabel').textContent)
            .toBe('Round-trip distance (km)');
    });
});

describe('stepNumInput', () => {
    test('clamps at min', () => {
        const input = document.getElementById('minDistance');
        input.value = '0';
        stepNumInput('minDistance', -0.5);
        expect(input.value).toBe('0');
    });

    test('clamps at max', () => {
        const input = document.getElementById('maxDistance');
        input.value = '100';
        stepNumInput('maxDistance', 0.5);
        expect(input.value).toBe('100');
    });

    test('treats a NaN/empty value as 0 then applies delta', () => {
        const input = document.getElementById('minDistance');
        input.value = '';
        stepNumInput('minDistance', 0.5);
        expect(input.value).toBe('0.5');
        input.value = 'abc';
        stepNumInput('minDistance', 0.5);
        expect(input.value).toBe('0.5');
    });

    test('skips clamp when min and max attributes are absent (NaN)', () => {
        const input = document.getElementById('unbounded');
        input.value = '0';
        stepNumInput('unbounded', -1);
        expect(input.value).toBe('-1');
    });

    test('steps inside the range', () => {
        const input = document.getElementById('maxDistance');
        input.value = '5';
        stepNumInput('maxDistance', 0.5);
        expect(input.value).toBe('5.5');
    });
});

describe('Enter-to-generate', () => {
    // Input listeners die with innerHTML; the document keydown listener
    // stacks across beforeEach reloads, so document-level asserts use
    // toHaveBeenCalled rather than an exact count.
    test.each(['location', 'minDistance', 'maxDistance'])(
        'Enter on #%s calls generateDestination',
        (id) => {
            globalThis.generateDestination = vi.fn();
            document.getElementById(id).dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
            expect(generateDestination).toHaveBeenCalledTimes(1);
        },
    );

    test('Ctrl+Enter on document calls generateDestination', () => {
        globalThis.generateDestination = vi.fn();
        const e = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true });
        document.dispatchEvent(e);
        expect(generateDestination).toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(true);
    });

    test('Cmd+Enter on document calls generateDestination', () => {
        globalThis.generateDestination = vi.fn();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
        expect(generateDestination).toHaveBeenCalled();
    });

    test('plain Enter on document does not generate', () => {
        globalThis.generateDestination = vi.fn();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(generateDestination).not.toHaveBeenCalled();
    });
});
