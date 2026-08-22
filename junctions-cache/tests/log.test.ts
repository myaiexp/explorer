// @vitest-environment node
// Tests for junctions-cache/src/log.ts — getRecentLogs ring-buffer slicing.
// Audit finding #3174: getRecentLogs(0) was clamped to 1 (Math.max(1, ...)),
// returning one log instead of an empty array. These cases pin the limit
// contract: 0 and negatives yield [], n>=1 returns the last n (capped at the
// 500-entry ring), and the slice(-0)===whole-array footgun is guarded.

import { describe, test, expect, beforeAll, vi } from 'vitest';
import { log, getRecentLogs } from '../src/log.js';

// log() writes one line per call to stdout; silence it for the bulk push below.
beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Overfill past RING_SIZE (500) so the cap is exercised; each entry carries
    // a monotonic index so ordering of the tail can be asserted.
    for (let i = 0; i < 600; i++) log('INFO', { i });
});

describe('getRecentLogs', () => {
    test('limit 0 returns an empty array (not 1, not the whole ring)', () => {
        expect(getRecentLogs(0)).toEqual([]);
    });

    test('negative limit is guarded to an empty array', () => {
        expect(getRecentLogs(-1)).toEqual([]);
        expect(getRecentLogs(-500)).toEqual([]);
    });

    test('limit 1 returns exactly the most recent entry', () => {
        const recent = getRecentLogs(1);
        expect(recent).toHaveLength(1);
        expect(recent[0]!.fields.i).toBe(599);
    });

    test('limit n returns the last n entries in insertion order', () => {
        const recent = getRecentLogs(3);
        expect(recent.map(e => e.fields.i)).toEqual([597, 598, 599]);
    });

    test('limit is capped at the ring size (500)', () => {
        expect(getRecentLogs(700)).toHaveLength(500);
        expect(getRecentLogs(500)).toHaveLength(500);
    });
});
