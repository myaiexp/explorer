/**
 * Tests for list-item.js — the shared row DOM (finding #13459): the delete button
 * all three lists use, and the destination-row render loop behind the history and
 * favorites lists.
 *
 * The click paths through real renderers stay in history.test.js and
 * favorites.test.js; this file pins the display rules that now live once.
 * SCRIPT_DEPS pulls visit-shape (destCoordsOrNull) in for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const row = (over = {}) => ({ id: 1, destLat: 62.12344, destLng: 25.98766, destName: 'Lake', distance: 3.14, ...over });

let list;

beforeEach(() => {
    document.body.innerHTML = '<div id="list"></div>';
    list = document.getElementById('list');
    loadScripts('list-item');
});

function render(entries, over = {}) {
    return renderDestRows(entries, list, {
        meta: destListDistance,
        onSelect: () => {},
        onDelete: () => {},
        warnLabel: 'testList',
        ...over,
    });
}

const names = () => [...list.querySelectorAll('.history-item-name')].map(n => n.textContent);
const metas = () => [...list.querySelectorAll('.history-item-meta')].map(n => n.textContent);

describe('buildDeleteButton', () => {
    test('builds the × button and hands the click event to onDelete', () => {
        const onDelete = vi.fn();
        const btn = buildDeleteButton(onDelete);
        expect(btn.type).toBe('button');
        expect(btn.className).toBe('history-delete');
        expect(btn.title).toBe('Remove');
        expect(btn.textContent).toBe('×');
        btn.click();
        expect(onDelete).toHaveBeenCalledWith(expect.any(Event));
    });
});

describe('destListLabel', () => {
    const dest = { destLat: 62.12344, destLng: 25.98766 };

    test('prefers the destination name', () => {
        expect(destListLabel({ destName: 'Lake' }, dest)).toBe('Lake');
    });

    test.each([[null], [''], [undefined]])('falls back to 4-decimal coords for name %j', (destName) => {
        expect(destListLabel({ destName }, dest)).toBe('62.1234, 25.9877');
    });
});

describe('destListDistance', () => {
    test('formats a finite distance to one decimal', () => {
        expect(destListDistance({ distance: 3.14 })).toBe('3.1 km');
    });

    test.each([[null], [undefined], [NaN], ['3.1']])('is empty for distance %j', (distance) => {
        expect(destListDistance({ distance })).toBe('');
    });
});

describe('renderDestRows', () => {
    test('replaces the list contents and returns the rendered count', () => {
        list.innerHTML = '<div class="history-item">stale</div>';
        expect(render([row(), row({ destName: null })])).toBe(2);
        expect(names()).toEqual(['Lake', '62.1234, 25.9877']);
        expect(metas()).toEqual(['3.1 km', '3.1 km']);
    });

    test('takes the meta line from the caller', () => {
        render([row()], { meta: (entry) => `id ${entry.id}` });
        expect(metas()).toEqual(['id 1']);
    });

    test('a skipped row keeps the indices of the rows after it, and warns once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const onSelect = vi.fn();
        const onDelete = vi.fn();
        const entries = [row(), row({ destLat: null }), row({ destLng: 'x' }), row({ destName: 'Last' })];

        expect(render(entries, { onSelect, onDelete })).toBe(2);
        expect(names()).toEqual(['Lake', 'Last']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^testList: skipped 2 /));

        const last = list.querySelectorAll('.history-item')[1];
        last.querySelector('.history-delete').click();
        expect(onDelete).toHaveBeenCalledWith(3, expect.any(Event));
        last.querySelector('.history-item-name').click();
        expect(onSelect.mock.calls.at(-1)).toEqual([3]);
        warn.mockRestore();
    });

    test('returns 0 and renders nothing when every row is unusable', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(render([row({ destLat: null })])).toBe(0);
        expect(list.children).toHaveLength(0);
        warn.mockRestore();
    });
});
