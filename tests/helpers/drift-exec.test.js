// @vitest-environment node
/**
 * Pins tests/helpers/drift-exec.js.
 *
 * execDriftScript bounds a drift-script spawn. ssh's ConnectTimeout does not
 * cover getaddrinfo, and a blocking spawn never returns to vitest's timer, so
 * the worker stays pinned unless the spawn itself is killed — including the
 * ssh inside $(...), which SIGTERM to bash alone leaves running. The
 * unreachable-host cases do not take that path: installFailingSsh is first
 * on their PATH.
 */
import { test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execDriftScript, DRIFT_SUBPROCESS_TIMEOUT_MS, installFailingSsh } from './drift-exec.js';

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

// The unreachable-host cases must not wait on getaddrinfo. ConnectTimeout
// starts after the lookup, so a slow negative answer blows vitest's 5s and
// the test fails even though ssh did return.
test('installFailingSsh exits 255 and records the host, without a lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-ssh-stub-'));
    try {
        const { bin, log } = installFailingSsh(dir);
        let status = null;
        try {
            execFileSync(join(bin, 'ssh'), ['-n', 'no-such-host-for-wander', 'true'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            status = e.status;
        }
        expect(status).toBe(255);
        expect(readFileSync(log, 'utf8')).toContain('no-such-host-for-wander');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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

// Derived from the directory, so a drift suite added later is held to it too.
test('every drift suite spawns only through execDriftScript', () => {
    const suites = readdirSync(TESTS_DIR).filter((n) => /drift.*\.test\.js$/.test(n));
    expect(suites).toEqual(expect.arrayContaining(['unit-drift.test.js', 'nginx-drift.test.js', 'drift-remote-read.test.js']));
    for (const name of suites) {
        const src = readFileSync(join(TESTS_DIR, name), 'utf8');
        expect(src).toMatch(/execDriftScript\((SCRIPT|script),/);
        expect(src).not.toContain('execFileSync');
    }
});
