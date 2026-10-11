// @vitest-environment node
/**
 * Pins tests/helpers/drift-exec.js.
 *
 * The deploy-drift suites really ssh. ConnectTimeout does not cover DNS, and a
 * blocking spawn never returns to vitest's timer, so the worker stays pinned
 * unless the spawn itself is killed — including the ssh inside $(...), which
 * SIGTERM to bash alone leaves running.
 */
import { test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execDriftScript, DRIFT_SUBPROCESS_TIMEOUT_MS } from './drift-exec.js';

// TASK_COMM_LEN is 16 including the trailing NUL, so the marker is 15 chars
// and pgrep -x matches this copy of sleep rather than any other sleeper.
const MARKER = 'wander-drift-h';
// This file lives in tests/helpers/, so one level up is the tests directory.
const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function markerPids() {
    try {
        return execFileSync('pgrep', ['-x', MARKER], { encoding: 'utf8' })
            .trim()
            .split('\n')
            .filter(Boolean);
    } catch {
        // pgrep exits 1 when nothing matches — that is the success case.
        return [];
    }
}

afterEach(() => {
    for (const pid of markerPids()) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
    }
});

test('the bound outlasts ssh ConnectTimeout and is finite', () => {
    expect(DRIFT_SUBPROCESS_TIMEOUT_MS).toBe(15_000);
});

test('a stuck command-substitution child is signalled and not orphaned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-exec-'));
    const marker = join(dir, MARKER);
    const hang = join(dir, 'hang.sh');
    const sleepBin = execFileSync('bash', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();
    copyFileSync(sleepBin, marker);
    // Same shape as read_installed: the remote command is a grandchild of the
    // script's bash, inside $(). 8s is past the 5s assertion, so a missing
    // timeout fails the test instead of passing by finishing.
    writeFileSync(hang, `out=$(${marker} 8)\necho "$out"\n`);
    const start = Date.now();
    let result;
    try {
        result = execDriftScript(hang, process.env, 800);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    expect(result.signal).toBe('SIGTERM');
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(markerPids()).toEqual([]);
});

test('both drift suites spawn only through execDriftScript', () => {
    for (const name of ['unit-drift.test.js', 'nginx-drift.test.js']) {
        const src = readFileSync(join(TESTS_DIR, name), 'utf8');
        expect(src).toContain('execDriftScript(SCRIPT,');
        expect(src).not.toContain('execFileSync');
    }
});
