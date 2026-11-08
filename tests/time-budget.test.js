// @vitest-environment jsdom
/**
 * Tests for time-budget.js — the minutes field beside max distance. Minutes
 * and max km are one budget at 5 km/h; an empty minutes field leaves km alone.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

// form-controls (the real stepNumInput) binds Enter on these three at load.
const FORM_HTML = `
  <input id="location">
  <input type="number" id="minDistance" min="0" max="100" step="0.5" value="0">
  <input type="number" id="maxDistance" min="0.5" max="100" step="0.5" value="5">
  <input type="number" id="maxMinutes" min="6" max="1200" step="5" value="">
`;

const km = () => document.getElementById('maxDistance');
const minutes = () => document.getElementById('maxMinutes');

function type(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function commit(input) {
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    globalThis.generateDestination = vi.fn();
    loadScripts('time-budget', 'form-controls');
});

describe('minutes → km', () => {
    test('60 minutes is 5 km', () => {
        type(minutes(), '60');
        expect(km().value).toBe('5');
    });

    test('rounds km to one decimal', () => {
        type(minutes(), '37');           // 37 / 12 = 3.083…
        expect(km().value).toBe('3.1');
    });

    test('clamps km to the max-distance input range', () => {
        type(minutes(), '2000');         // 166.7 km > max 100
        expect(km().value).toBe('100');
        type(minutes(), '1');            // 0.08 km < min 0.5
        expect(km().value).toBe('0.5');
    });

    test('clearing minutes leaves km as it was', () => {
        type(minutes(), '36');
        expect(km().value).toBe('3');
        type(minutes(), '');
        expect(km().value).toBe('3');
    });

    test('a non-numeric or non-positive minutes value leaves km alone', () => {
        type(minutes(), '-10');
        expect(km().value).toBe('5');
        type(minutes(), '0');
        expect(km().value).toBe('5');
    });

    test('committing an out-of-range minutes value rewrites it to the clamped km', () => {
        type(minutes(), '2000');
        commit(minutes());
        expect(minutes().value).toBe('1200');
    });

    test('committing an in-range value keeps exactly what the user typed', () => {
        type(minutes(), '37');
        commit(minutes());
        expect(minutes().value).toBe('37');
    });
});

describe('km → minutes', () => {
    test('updates a filled minutes field', () => {
        type(minutes(), '60');
        type(km(), '7.5');
        expect(minutes().value).toBe('90');
    });

    test('rounds minutes to a whole number', () => {
        type(minutes(), '60');
        type(km(), '3.3');               // 39.6 min
        expect(minutes().value).toBe('40');
    });

    test('an empty minutes field stays empty — km is the source of truth', () => {
        type(km(), '8');
        expect(minutes().value).toBe('');
    });

    test('a cleared or invalid km leaves minutes alone mid-edit', () => {
        type(minutes(), '60');
        type(km(), '');
        expect(minutes().value).toBe('60');
    });
});

describe('stepBudgetMinutes', () => {
    // A bare stepNumInput on an empty field starts from 0, clamps to min=6 and
    // drags km down to 0.5 — the stepper must start from the km budget instead.
    test('an empty minutes field steps from the current km', () => {
        stepBudgetMinutes(5);
        expect(minutes().value).toBe('65');
        expect(km().value).toBe('5.4');
    });

    test('stepping down from empty also starts at the km budget', () => {
        stepBudgetMinutes(-5);
        expect(minutes().value).toBe('55');
        expect(km().value).toBe('4.6');
    });

    test('a filled minutes field steps from its own value', () => {
        type(minutes(), '37');
        stepBudgetMinutes(5);
        expect(minutes().value).toBe('42');
        expect(km().value).toBe('3.5');
    });
});
