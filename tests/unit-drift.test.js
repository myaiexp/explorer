// @vitest-environment node
/**
 * Pins deploy/check-unit-drift.sh — the answer to idea #4018.
 *
 * wander-junctions.service ran on shelly for MONTHS as the old pre-#7755 unit
 * (no dedicated user, cache still under /home/shelly) while
 * junctions-cache/tests/wander-junctions-service.test.ts asserted the hardened
 * shape and passed on every run. Both were true: the test read the REPO copy,
 * and `deploy` / the post-receive hook restart a unit but never install it. A
 * test that reads a repo file proves the intent, never the deployment — so the
 * deployment needs its own check, and this file pins that one.
 *
 * Two halves:
 *  - the class guard: every unit under deploy/ declares `# deploy-host:`, so a
 *    unit added later joins the drift check without anyone remembering to add
 *    it to a list. That is the part that would have caught the original miss.
 *  - the comparison itself: ok / DRIFT / MISSING / undeclared-host, driven
 *    through the script's two seams against a fixture tree.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'deploy/check-unit-drift.sh');

// Every systemd unit committed under deploy/, at any depth (shelly-osrm/,
// shelly-overpass/, …). Derived from the tree rather than listed, so the guard
// below cannot go stale the way a hand-kept list would.
function unitFiles(dir = resolve(ROOT, 'deploy'), out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) unitFiles(p, out);
        else if (/\.(service|timer)$/.test(e.name)) out.push(p);
    }
    return out;
}

describe('deploy/ units declare where they are installed', () => {
    const units = unitFiles();

    test('the tree actually holds units (a broken scan must not pass vacuously)', () => {
        expect(units.length).toBeGreaterThanOrEqual(5);
    });

    test.each(unitFiles().map((p) => [p.slice(ROOT.length + 1), p]))(
        '%s declares a deploy-host',
        (_rel, path) => {
            const header = readFileSync(path, 'utf8');
            const m = header.match(/^#\s*deploy-host:\s*(\S+)\s*$/m);
            expect(m, 'missing a "# deploy-host: <host>" line').not.toBeNull();
            // `local` means this box; anything else is an ssh destination.
            expect(m[1]).toMatch(/^[A-Za-z0-9._-]+$/);
        },
    );
});

describe('check-unit-drift.sh', () => {
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'unitdrift-'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'installed'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // The script's two seams: which tree to scan, and where a `local` unit is
    // installed. Both default to the production paths.
    function run() {
        try {
            const stdout = execFileSync('bash', [SCRIPT], {
                env: {
                    ...process.env,
                    UNIT_SRC_DIR: join(dir, 'src'),
                    SYSTEMD_UNIT_DIR: join(dir, 'installed'),
                },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { code: 0, out: stdout };
        } catch (e) {
            return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
        }
    }

    function unit(name, body, { installed = null } = {}) {
        writeFileSync(join(dir, 'src', name), body);
        if (installed !== null) writeFileSync(join(dir, 'installed', name), installed);
    }

    const OK_UNIT = '# deploy-host: local\n[Service]\nExecStart=/bin/true\n';

    test('is executable, so the deploy hook can run it', () => {
        expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
    });

    test('an installed copy identical to the repo copy passes', () => {
        unit('a.service', OK_UNIT, { installed: OK_UNIT });
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*ok/);
        expect(code).toBe(0);
    });

    // The count is the guard against a partial sweep reading as a clean one.
    // The first real run checked 2 of 6 units and reported success on those two,
    // because ssh inside the read-loop drained the loop's own stdin (fixed with
    // ssh -n). A per-unit line looks identical whether the sweep finished or not.
    test('reports how many units it checked, and checks every one', () => {
        unit('a.service', OK_UNIT, { installed: OK_UNIT });
        unit('b.service', OK_UNIT, { installed: OK_UNIT });
        unit('c.timer', OK_UNIT, { installed: OK_UNIT });
        const { code, out } = run();
        expect(code).toBe(0);
        expect(out).toMatch(/none \(3 checked\)/);
    });

    test('an empty tree fails rather than reporting a clean sweep of nothing', () => {
        const { code, out } = run();
        expect(out).toMatch(/no units found/);
        expect(code).not.toBe(0);
    });

    test('a changed installed copy is DRIFT and fails', () => {
        unit('a.service', OK_UNIT, { installed: OK_UNIT.replace('/bin/true', '/bin/false') });
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*DRIFT/);
        expect(code).not.toBe(0);
    });

    test('a unit that was never installed is MISSING and fails', () => {
        unit('a.service', OK_UNIT);
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*MISSING/);
        expect(code).not.toBe(0);
    });

    // Without this the scheme would be opt-in, and an author who forgets the
    // header gets exactly the silence idea #4018 is about.
    test('a unit with no deploy-host header fails rather than being skipped', () => {
        unit('a.service', '[Service]\nExecStart=/bin/true\n', { installed: '[Service]\nExecStart=/bin/true\n' });
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*(no deploy-host|UNDECLARED)/i);
        expect(code).not.toBe(0);
    });

    test('one drifted unit still fails a run where others are fine', () => {
        unit('a.service', OK_UNIT, { installed: OK_UNIT });
        unit('b.service', OK_UNIT, { installed: OK_UNIT.replace('/bin/true', '/bin/false') });
        unit('c.timer', OK_UNIT, { installed: OK_UNIT });
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*ok/);
        expect(out).toMatch(/b\.service.*DRIFT/);
        expect(out).toMatch(/c\.timer.*ok/);
        expect(code).not.toBe(0);
    });

    test('scans nested directories — shelly-osrm/ and shelly-overpass/ live there', () => {
        mkdirSync(join(dir, 'src', 'shelly-thing'));
        writeFileSync(join(dir, 'src', 'shelly-thing', 'n.service'), OK_UNIT);
        const { code, out } = run();
        expect(out).toMatch(/n\.service.*MISSING/);
        expect(code).not.toBe(0);
    });

    test('an unreachable host warns without failing — an ssh outage is not drift', () => {
        unit('a.service', '# deploy-host: no-such-host-for-wander\n[Service]\n');
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*(unreachable|UNREACHABLE)/i);
        expect(code).toBe(0);
    });
});
