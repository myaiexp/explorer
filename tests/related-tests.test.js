// @vitest-environment node
/**
 * Pins the root-script → test-file resolver behind `pnpm test:related`.
 *
 * `vitest related geometry.js` prints "No test files found" and exits 0: it
 * walks static ESM imports, and tests/helpers/load.js evaluates the root
 * scripts from text, so no test file imports them. A scoped run of a changed
 * root script therefore passed vacuously. The resolver reads the edges the
 * tests actually have — loadScripts/readScript names, '<name>.js' literals,
 * whole-tree readers and helper imports — and walks SCRIPT_DEPS backwards.
 */
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveRelated } from './helpers/related-tests.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'scripts/test-related.mjs');

const related = (...targets) => resolveRelated(ROOT, targets);

describe('resolveRelated', () => {
    test('geometry.js maps to the suite that loads it by name', () => {
        const { files, errors } = related('geometry.js');
        expect(errors).toEqual([]);
        expect(files).toContain('tests/geometry.test.js');
        expect(files).toContain('tests/loop-vias.test.js');
    });

    // loop-builders' SCRIPT_DEPS name geometry, so a suite that loads
    // loop-builders runs geometry.js too and belongs in its scoped run.
    test('walks SCRIPT_DEPS backwards to the suites of dependents', () => {
        expect(related('geometry.js').files).toContain('tests/junction-loop.test.js');
        expect(related('geo-utils.js').files).toContain('tests/screening.test.js');
    });

    test('a script loaded only through a helper maps to the suites importing it', () => {
        expect(related('sync-flush.js').files).toContain('tests/sync-flush.test.js');
    });

    test("a '<name>.js' literal counts as an edge", () => {
        expect(related('storage.js').files).toContain('tests/geometry-keep-parity.test.js');
    });

    test('a suite that reads every root script is related to each of them', () => {
        expect(related('geometry.js').files).toContain('tests/global-collisions.test.js');
        expect(related('toast.js').files).toContain('tests/global-collisions.test.js');
    });

    test('does not pull in suites that never touch the script', () => {
        expect(related('geometry.js').files).not.toContain('tests/nginx-drift.test.js');
        expect(related('geometry.js').files).not.toContain('tests/sync-flush.test.js');
    });

    test('a test file passes through, and a helper maps to the suites importing it', () => {
        expect(related('tests/geometry.test.js').files).toEqual(['tests/geometry.test.js']);
        expect(related('tests/helpers/drift-exec.js').files).toContain('tests/unit-drift.test.js');
    });

    test('accepts absolute and ./ paths for the same file', () => {
        expect(related(resolve(ROOT, 'geometry.js')).files).toEqual(related('geometry.js').files);
        expect(related('./geometry.js').files).toEqual(related('geometry.js').files);
    });

    test('an unknown file is an error, not an empty pass', () => {
        const { errors } = related('no-such-script.js');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/no-such-script\.js/);
    });

    test('a file outside the root suite is an error naming its own suite', () => {
        const { errors } = related('server/src/app.ts');
        expect(errors[0]).toMatch(/server\//);
    });

    test('a root script no test reaches is an error', () => {
        const { errors } = resolveRelated(ROOT, ['geometry.js'], { tests: [] });
        expect(errors[0]).toMatch(/no test/i);
    });
});

describe('scripts/test-related.mjs', () => {
    function cli(...args) {
        try {
            return { code: 0, out: execFileSync('node', [CLI, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
        } catch (e) {
            return { code: e.status, out: `${e.stdout}${e.stderr}` };
        }
    }

    test('--list prints the resolved files without running vitest', () => {
        const { code, out } = cli('--list', 'geometry.js');
        expect(code).toBe(0);
        expect(out.split('\n')).toContain('tests/geometry.test.js');
    });

    test('an unknown script exits non-zero', () => {
        const { code, out } = cli('--list', 'no-such-script.js');
        expect(code).not.toBe(0);
        expect(out).toMatch(/no-such-script\.js/);
    });

    test('no arguments is a usage error', () => {
        expect(cli().code).not.toBe(0);
    });
});
