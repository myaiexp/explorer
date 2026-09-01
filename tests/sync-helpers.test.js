// @vitest-environment jsdom
/**
 * Tests for sync-helpers.js — the persist-and-mirror gate on writeStoredArray.
 *
 * storage.test.js owns reclaim mechanics and the false return itself. This
 * suite owns the consumer contract: when the local write fails, syncedPut /
 * syncedDelete must not enqueue an outbox mutate (audit #5713). Without that
 * gate, a full quota leaves cloud claiming a put/delete localStorage never
 * accepted.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

let mutations;
let writeOk;

beforeEach(() => {
  localStorage.clear();
  mutations = [];
  writeOk = true;

  globalThis.writeStoredArray = (key, arr) => {
    // Record what would have been written only when the write "succeeds".
    if (!writeOk) return false;
    localStorage.setItem(key, JSON.stringify(arr));
    return true;
  };
  globalThis.WanderSync = {
    mutate: (section, op, id, data) => mutations.push({ section, op, id, data }),
    getState: () => ({ state: 'anonymous' }),
    requestConsent: () => {},
  };

  loadScripts('sync-helpers');
});

describe('syncedPut', () => {
  test('mirrors to the outbox after a durable local write', () => {
    const ok = syncedPut('walk_history', [{ id: 'h1' }], 'history', 'h1', { id: 'h1' });

    expect(ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('walk_history'))).toEqual([{ id: 'h1' }]);
    expect(mutations).toEqual([
      { section: 'history', op: 'put', id: 'h1', data: { id: 'h1' } },
    ]);
  });

  test('does not mutate when writeStoredArray returns false', () => {
    writeOk = false;

    const ok = syncedPut('walk_history', [{ id: 'h1' }], 'history', 'h1', { id: 'h1' });

    expect(ok).toBe(false);
    expect(localStorage.getItem('walk_history')).toBeNull();
    expect(mutations).toEqual([]);
  });
});

describe('syncedDelete', () => {
  test('mirrors a delete after a durable local write', () => {
    const ok = syncedDelete('walk_favorites', [], 'favorites', 'f1');

    expect(ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('walk_favorites'))).toEqual([]);
    expect(mutations).toEqual([
      { section: 'favorites', op: 'delete', id: 'f1', data: undefined },
    ]);
  });

  test('does not mutate when writeStoredArray returns false', () => {
    writeOk = false;

    const ok = syncedDelete('walk_favorites', [], 'favorites', 'f1');

    expect(ok).toBe(false);
    expect(mutations).toEqual([]);
  });
});
