// @vitest-environment jsdom
/**
 * Tests for loading.js — the one-build-at-a-time mutex.
 *
 * loading.js is a non-module browser script; helpers/load.js evaluates it so its
 * free identifier (showWarning) resolves to the stub installed on globalThis,
 * mirroring what index.html wires at runtime.
 *
 * These pin the audit fix: #generateBtn being disabled was the ONLY concurrency
 * guard, and Enter / Ctrl+Enter / the surprise button / a pick-mode map click /
 * the spread slider all reach a build without touching it. Two overlapping builds
 * interleave over the Leaflet layers, the current session and the history store.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

let warnings;

// A promise we resolve by hand, so a build can be held "in flight".
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  warnings = [];
  document.body.innerHTML =
    '<div id="loading"><p>Finding your random destination…</p></div>' +
    '<button id="generateBtn"></button>';
  globalThis.showWarning = (msg) => warnings.push(msg);
  loadScripts('loading');
});

describe('withLoading mutex', () => {
  test('a second build is rejected while the first is in flight', async () => {
    const first = deferred();
    const ran = [];

    const a = withLoading(async () => { ran.push('a'); await first.promise; });
    const b = await withLoading(async () => { ran.push('b'); });

    expect(b).toBe(false);
    expect(ran).toEqual(['a']);
    expect(warnings).toHaveLength(1);

    first.resolve();
    expect(await a).toBe(true);
  });

  test('the spinner and the generate button stay engaged for the whole first build', async () => {
    const first = deferred();
    const loadingEl = document.getElementById('loading');
    const genBtn = document.getElementById('generateBtn');

    const a = withLoading(async () => { await first.promise; });
    await withLoading(async () => {}); // rejected — must not tear the UI down

    expect(loadingEl.classList.contains('active')).toBe(true);
    expect(genBtn.disabled).toBe(true);

    first.resolve();
    await a;
    expect(loadingEl.classList.contains('active')).toBe(false);
    expect(genBtn.disabled).toBe(false);
  });

  test('the mutex releases after a build throws, and restores the caption', async () => {
    await expect(withLoading(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    expect(isBuilding()).toBe(false);
    expect(document.querySelector('#loading p').textContent)
      .toBe('Finding your random destination…');
    expect(await withLoading(async () => {})).toBe(true);
  });

  test('rejectIfBuilding reports and warns only while a build runs', async () => {
    expect(rejectIfBuilding()).toBe(false);
    expect(warnings).toHaveLength(0);

    const first = deferred();
    const a = withLoading(async () => { await first.promise; });

    expect(rejectIfBuilding()).toBe(true);
    expect(warnings).toHaveLength(1);

    first.resolve();
    await a;
    expect(rejectIfBuilding()).toBe(false);
  });

  test('onProgress writes the loading caption', async () => {
    await withLoading(async (onProgress) => { onProgress('Snapping to roads…'); });
    // Reset in the finally, so the caption is back to the default afterwards.
    expect(document.querySelector('#loading p').textContent)
      .toBe('Finding your random destination…');

    const first = deferred();
    const a = withLoading(async (onProgress) => { onProgress('Snapping to roads…'); await first.promise; });
    await Promise.resolve();
    expect(document.querySelector('#loading p').textContent).toBe('Snapping to roads…');
    first.resolve();
    await a;
  });
});
