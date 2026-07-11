// @vitest-environment jsdom
/**
 * Tests for storage.js — the array-backed read/write accessors. jsdom supplies
 * localStorage; storage.js is a non-module browser script run via vm, exposing
 * its helpers on globalThis. Focus: the read/write round-trip symmetry that lets
 * sync-helpers.js's syncedPut/syncedDelete keep the persist-and-mirror invariant in one place.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

beforeAll(() => {
    const src = readFileSync(resolve(__dirname, '../storage.js'), 'utf8');
    new vm.Script(src).runInThisContext();
});

beforeEach(() => localStorage.clear());

describe('writeStoredArray / readStoredArray', () => {
    test('round-trips an array through localStorage', () => {
        const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
        globalThis.writeStoredArray('k', rows);
        expect(localStorage.getItem('k')).toBe(JSON.stringify(rows));
        expect(globalThis.readStoredArray('k')).toEqual(rows);
    });

    test('writing an empty array reads back as empty (not the missing-key default)', () => {
        globalThis.writeStoredArray('k', []);
        expect(globalThis.readStoredArray('k')).toEqual([]);
    });

    test('readStoredArray returns [] for a missing or corrupt key', () => {
        expect(globalThis.readStoredArray('absent')).toEqual([]);
        localStorage.setItem('bad', '{not json');
        expect(globalThis.readStoredArray('bad')).toEqual([]);
    });
});
