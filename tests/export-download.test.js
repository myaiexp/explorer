// @vitest-environment jsdom
/**
 * Tests for the file-download wiring — export.js triggerDownload and the
 * visits-io.js exportVisits that now reuses it (audit: DRY, blob-download
 * single-sourced). Both are non-module browser scripts; helpers/load.js
 * evaluates them (plus visits-io's visit-shape dependency) in the jsdom realm.
 * jsdom lacks URL.createObjectURL and <a>.click, so we stub the former and
 * capture the latter to read back the resolved download filename.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

// Load export.js (defines triggerDownload) then visits-io.js (uses it), mirroring
// index.html's order.
loadScripts('export', 'visits-io');

let lastDownload;

beforeEach(() => {
    lastDownload = null;
    vi.restoreAllMocks();
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();
    // Capture the <a download> the triggerDownload path clicks, without navigating.
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        const el = realCreate(tag);
        if (tag === 'a') el.click = () => { lastDownload = el.download; };
        return el;
    });
});

describe('triggerDownload filename resolution', () => {
    test('sanitizes name → <slug>.<ext> when no explicit filename', () => {
        globalThis.triggerDownload('data', 'Wander Route!!', 'gpx', 'application/gpx+xml');
        expect(lastDownload).toBe('wander-route.gpx');
    });

    test('empty/garbage name falls back to route.<ext>', () => {
        globalThis.triggerDownload('data', '@@@', 'fit', 'application/vnd.ant.fit');
        expect(lastDownload).toBe('route.fit');
    });

    test('explicit filename is used verbatim (bypasses the sanitizer)', () => {
        globalThis.triggerDownload('data', 'ignored', 'json', 'application/json', 'walks-2026-07-18.json');
        expect(lastDownload).toBe('walks-2026-07-18.json');
    });
});

describe('exportVisits', () => {
    test('downloads a date-stamped file through triggerDownload', () => {
        globalThis.getVisits = () => [{ id: 'a', destName: 'Park' }];
        globalThis.exportVisits();
        expect(lastDownload).toMatch(/^walks-\d{4}-\d{2}-\d{2}\.json$/);
    });

    test('shows an error and downloads nothing when there are no visits', () => {
        globalThis.getVisits = () => [];
        globalThis.showError = vi.fn();
        globalThis.exportVisits();
        expect(globalThis.showError).toHaveBeenCalled();
        expect(lastDownload).toBeNull();
    });
});
