// @vitest-environment jsdom
/**
 * Tests for share-link.js — hash encode/restore, clipboard copy, Finland gate.
 *
 * share-link.js is a non-module browser script; helpers/load.js evaluates it so
 * its free identifiers resolve to the stubs installed on globalThis. bbox.js
 * (inFinland) is the one real collaborator (SCRIPT_DEPS); buildAndDisplay /
 * toast / session are faked.
 *
 * These pin the audit cleanup: restoreFromHash's parse used to sit inside a
 * try/catch whose catch was unreachable (URLSearchParams/split/Number/isNaN have
 * no failure mode here), which forced the parsed values through a staging object
 * to escape the block. The early returns below are — and always were — the whole
 * malformed-link handling, so these cover every shape the catch pretended to.
 * Out-of-Finland coords are not malformed — they surface the same user-facing
 * error as resolveStart (finding #7780). copyRouteLink's clipboard path is
 * finding #7783.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

let built;
let errors;
let successes;

const SESSION = {
  startLat: 62.1, startLng: 25.7, destLat: 62.2, destLng: 25.8,
  tripMode: 'round', destName: 'Harju',
};

function stubClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  built = [];
  errors = [];
  successes = [];
  document.body.innerHTML =
    '<input id="location">' +
    '<input type="radio" name="tripMode" id="roundTrip" checked>' +
    '<input type="radio" name="tripMode" id="oneWay">';
  location.hash = '';

  globalThis.showError = (msg) => errors.push(msg);
  globalThis.showSuccess = (msg) => successes.push(msg);
  globalThis.getCurrentSession = () => null;
  globalThis.withLoading = async (fn) => { await fn(() => {}); return true; };
  globalThis.buildAndDisplay = async (...args) => { built.push(args); };
  loadScripts('share-link');
});

describe('restoreFromHash', () => {
  test('a well-formed link restores the route and the trip mode', async () => {
    location.hash = '#s=62.100000,25.700000&d=62.200000,25.800000&m=one-way&n=Harju';
    await restoreFromHash();

    expect(built).toHaveLength(1);
    const [startLat, startLng, destLat, destLng, opts] = built[0];
    expect([startLat, startLng, destLat, destLng]).toEqual([62.1, 25.7, 62.2, 25.8]);
    expect(opts.tripMode).toBe('one-way');
    expect(opts.destName).toBe('Harju');
    expect(document.getElementById('location').value).toBe('62.100000,25.700000');
    expect(document.getElementById('oneWay').checked).toBe(true);
    // Hash cleared so a reload doesn't re-trigger the restore.
    expect(location.hash).toBe('');
  });

  test('defaults to a round trip with no name when m/n are absent', async () => {
    location.hash = '#s=62.1,25.7&d=62.2,25.8';
    await restoreFromHash();

    expect(built[0][4].tripMode).toBe('round');
    expect(built[0][4].destName).toBe(null);
    expect(document.getElementById('roundTrip').checked).toBe(true);
  });

  test.each([
    ['no hash at all', ''],
    ['missing dest', '#s=62.1,25.7'],
    ['missing start', '#d=62.2,25.8'],
    ['non-numeric coords', '#s=abc,def&d=62.2,25.8'],
    // Number('') is 0 — a half-empty pair must not restore as lng 0.
    ['half-empty coord pair', '#s=62.1,&d=62.2,25.8'],
    ['single-value coord', '#s=62.1&d=62.2,25.8'],
    ['three-value coord', '#s=62.1,25.7,3&d=62.2,25.8'],
    ['unrelated hash', '#settings'],
  ])('silently no-ops on a malformed link: %s', async (_label, hash) => {
    location.hash = hash;
    await restoreFromHash();

    expect(built).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('a routing failure surfaces to the user instead of being swallowed', async () => {
    globalThis.buildAndDisplay = async () => { throw new Error('OSRM unreachable'); };
    location.hash = '#s=62.1,25.7&d=62.2,25.8';
    await restoreFromHash();

    expect(errors).toEqual(['OSRM unreachable']);
  });

  // Stockholm sits west of FINLAND_BBOX.minLng (19.0). generateDestination
  // never produces this — resolveStart rejects it first — but a shared link
  // used to skip that gate and send the coords to OSRM-foot (Finland only).
  test('a start outside Finland is a user-facing error and does not route', async () => {
    location.hash = '#s=59.3293,18.0686&d=62.200000,25.800000';
    await restoreFromHash();

    expect(built).toHaveLength(0);
    expect(errors).toEqual([
      'Wander only routes within Finland — pick a starting location inside the country.',
    ]);
    expect(document.getElementById('location').value).toBe('');
  });

  test('a dest outside Finland is a user-facing error and does not route', async () => {
    location.hash = '#s=62.100000,25.700000&d=59.3293,18.0686';
    await restoreFromHash();

    expect(built).toHaveLength(0);
    expect(errors).toEqual([
      'Wander only routes within Finland — pick a starting location inside the country.',
    ]);
  });
});

describe('encodeRouteHash', () => {
  test('returns undefined with no active session', () => {
    expect(encodeRouteHash()).toBeUndefined();
  });

  test('round-trips through restoreFromHash', async () => {
    globalThis.getCurrentSession = () => SESSION;
    const hash = encodeRouteHash();
    expect(hash).toContain('n=Harju');

    location.hash = hash;
    await restoreFromHash();
    const [startLat, startLng, destLat, destLng, opts] = built[0];
    expect([startLat, startLng, destLat, destLng]).toEqual([62.1, 25.7, 62.2, 25.8]);
    expect(opts.destName).toBe('Harju');
  });
});

describe('copyRouteLink', () => {
  test('copies origin+pathname+hash and toasts success', async () => {
    globalThis.getCurrentSession = () => SESSION;
    const hash = encodeRouteHash();
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);

    copyRouteLink();

    expect(writeText).toHaveBeenCalledWith(location.origin + location.pathname + hash);
    await writeText.mock.results[0].value;
    expect(successes).toEqual(['Link copied to clipboard.']);
    expect(errors).toHaveLength(0);
  });

  test('clipboard rejection toasts a copy-failed error', async () => {
    globalThis.getCurrentSession = () => SESSION;
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    stubClipboard(writeText);

    copyRouteLink();
    await writeText.mock.results[0].value.catch(() => {});

    expect(errors).toEqual(['Failed to copy link.']);
    expect(successes).toHaveLength(0);
  });

  test('no-ops when encodeRouteHash has nothing to share', () => {
    const writeText = vi.fn();
    stubClipboard(writeText);

    copyRouteLink();

    expect(writeText).not.toHaveBeenCalled();
    expect(successes).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
