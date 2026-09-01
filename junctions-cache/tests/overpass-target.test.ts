// @vitest-environment node
// Tests for junctions-cache/src/overpass-target.ts — the local-first target
// choice and the 5-minute down-latch that flips it to the public fallback.
//
// The latch is module state (a single `localDownUntil` number), so every test
// starts from _resetLatch(). Vitest's fake timers mock Date as well as the
// timer functions, which is what lets the expiry test move the clock past the
// latch window without sleeping.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    currentTarget,
    markLocalDown,
    isLocalDown,
    _resetLatch,
    LOCAL_DOWN_LATCH_MS,
    LOCAL_URL,
    FALLBACK_URL,
} from '../src/overpass-target.js';

describe('overpass target selection', () => {
    beforeEach(() => {
        _resetLatch();
    });

    afterEach(() => {
        _resetLatch();
        vi.useRealTimers();
    });

    test('local target used when the latch is clear', () => {
        expect(currentTarget()).toEqual({ url: LOCAL_URL, local: true });
    });

    test('markLocalDown flips the target to the public fallback', () => {
        markLocalDown();
        expect(currentTarget().local).toBe(false);
        expect(currentTarget().url).toBe(FALLBACK_URL);
    });

    test('the latch expires after LOCAL_DOWN_LATCH_MS and returns to local', () => {
        vi.useFakeTimers();
        markLocalDown();
        expect(currentTarget().local).toBe(false);
        // Still latched a millisecond before the window closes.
        vi.advanceTimersByTime(LOCAL_DOWN_LATCH_MS - 1);
        expect(currentTarget().local).toBe(false);
        vi.advanceTimersByTime(2);
        expect(currentTarget()).toEqual({ url: LOCAL_URL, local: true });
    });

    test('isLocalDown reflects the latch', () => {
        vi.useFakeTimers();
        expect(isLocalDown()).toBe(false);
        markLocalDown();
        expect(isLocalDown()).toBe(true);
        vi.advanceTimersByTime(LOCAL_DOWN_LATCH_MS + 1);
        expect(isLocalDown()).toBe(false);
        // Re-latching restarts the full window rather than extending nothing.
        markLocalDown();
        expect(isLocalDown()).toBe(true);
        _resetLatch();
        expect(isLocalDown()).toBe(false);
    });

    test('the default local URL is the self-hosted container, not the public API', () => {
        // Guards against the pre-local-first default silently coming back.
        expect(LOCAL_URL).not.toBe(FALLBACK_URL);
        expect(FALLBACK_URL).toContain('overpass-api.de');
    });
});
