// Pins generateUsername + wordlists to the client USERNAME_RE (finding #7778).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateUsername } from './username.js';
import adjectives from './wordlists/adjectives.js';
import nouns from './wordlists/nouns.js';

// Must stay in lockstep with `var USERNAME_RE` in sync.js — parseUrlUsername
// rejects any minted name that does not match, so the backup link cannot be
// adopted. The client regex is not importable (IIFE, no build step).
const USERNAME_RE = /^[a-z]+-[a-z]+-\d{1,2}$/;
const WORD_RE = /^[a-z]+$/;

const syncJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../sync.js'),
  'utf8',
);

describe('client USERNAME_RE lockstep (finding #7778)', () => {
  it('still is /^[a-z]+-[a-z]+-\\d{1,2}$/ in sync.js', () => {
    expect(syncJs).toMatch(/var USERNAME_RE = \/\^\[a-z\]\+-\[a-z\]\+-\\d\{1,2\}\$\/;/);
  });
});

describe('username wordlists (finding #7778)', () => {
  it('are non-empty', () => {
    expect(adjectives.length).toBeGreaterThan(0);
    expect(nouns.length).toBeGreaterThan(0);
  });

  it('every adjective is /^[a-z]+$/', () => {
    const bad = adjectives.filter((w) => !WORD_RE.test(w));
    expect(bad).toEqual([]);
  });

  it('every noun is /^[a-z]+$/', () => {
    const bad = nouns.filter((w) => !WORD_RE.test(w));
    expect(bad).toEqual([]);
  });
});

describe('generateUsername (finding #7778)', () => {
  it('always matches the client USERNAME_RE across hundreds of samples', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateUsername()).toMatch(USERNAME_RE);
    }
  });

  it('emits adj-noun-N with N in 0..99 (1–2 digits)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const name = generateUsername();
      const parts = name.split('-');
      expect(parts).toHaveLength(3);
      expect(adjectives).toContain(parts[0]);
      expect(nouns).toContain(parts[1]);
      const n = Number(parts[2]);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(100);
      seen.add(n);
    }
    // 500 draws from 0..99 should land more than one value; a stuck `n = 0`
    // (or a 3-digit range that coincidentally passed USERNAME_RE) would fail.
    expect(seen.size).toBeGreaterThan(1);
  });
});
