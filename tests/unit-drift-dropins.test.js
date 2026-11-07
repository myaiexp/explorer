// @vitest-environment node
/**
 * Pins how deploy/check-unit-drift.sh treats systemd drop-ins — the
 * /etc/systemd/system/<unit>.d/*.conf fragments systemd layers over a unit.
 *
 * osrm-refresh.service on shelly carried a stale boost-compat.conf drop-in
 * (LD_LIBRARY_PATH at a deleted dir) for six weeks while every deploy said
 * "osrm-refresh.service ok", because the check read only the main unit file.
 * A drop-in changes behaviour exactly as much as the unit does, so an
 * installed one the repo does not commit beside the unit is DRIFT.
 *
 * Also pins the other half of committing one: a <unit>.d/*.conf is not an
 * nginx conf, and check-nginx-drift.sh must not scan it as one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execDriftScript, installSsh } from './helpers/drift-exec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'deploy/check-unit-drift.sh');
const script = resolve(ROOT, 'deploy/check-nginx-drift.sh');

const UNIT = '# deploy-host: local\n[Service]\nExecStart=/bin/true\n';
const DROPIN = '[Service]\nEnvironment=LD_LIBRARY_PATH=/opt/gone\n';

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dropin-drift-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'installed'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(extraEnv = {}) {
    return execDriftScript(SCRIPT, {
        ...process.env,
        UNIT_SRC_DIR: join(dir, 'src'),
        SYSTEMD_UNIT_DIR: join(dir, 'installed'),
        ...extraEnv,
    });
}

// SCRIPT is the unit check, `script` the nginx one: drift-exec.test.js's
// guard checks every drift suite spawns through execDriftScript(SCRIPT|script, …).

// side is 'src' (committed beside the unit) or 'installed' (on the host).
function write(side, rel, body) {
    const p = join(dir, side, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
}

describe('check-unit-drift.sh drop-ins', () => {
    test('an installed drop-in the repo does not commit is DRIFT naming it', () => {
        write('src', 'a.service', UNIT);
        write('installed', 'a.service', UNIT);
        write('installed', 'a.service.d/boost-compat.conf', DROPIN);
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*DRIFT.*boost-compat\.conf/);
        expect(code).not.toBe(0);
    });

    test('a committed drop-in that matches the installed one is ok', () => {
        write('src', 'a.service', UNIT);
        write('src', 'a.service.d/limits.conf', `# why it exists\n${DROPIN}`);
        write('installed', 'a.service', UNIT);
        write('installed', 'a.service.d/limits.conf', DROPIN);
        const { code, out } = run();
        expect(out).toMatch(/a\.service\s+ok/);
        expect(code).toBe(0);
    });

    test('a committed drop-in that was never installed is DRIFT', () => {
        write('src', 'a.service', UNIT);
        write('src', 'a.service.d/limits.conf', DROPIN);
        write('installed', 'a.service', UNIT);
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*DRIFT.*limits\.conf/);
        expect(code).not.toBe(0);
    });

    test('a drop-in whose content changed on the host is DRIFT', () => {
        write('src', 'a.service', UNIT);
        write('src', 'a.service.d/limits.conf', DROPIN);
        write('installed', 'a.service', UNIT);
        write('installed', 'a.service.d/limits.conf', DROPIN.replace('/opt/gone', '/opt/other'));
        const { code, out } = run();
        expect(out).toMatch(/a\.service.*DRIFT/);
        expect(code).not.toBe(0);
    });

    // systemd reads only *.conf from a drop-in dir; an empty dir (shelly has
    // one for osrm-foot.service) or a stray backup file changes nothing.
    test('an empty drop-in dir and non-.conf files there are not drift', () => {
        write('src', 'a.service', UNIT);
        write('installed', 'a.service', UNIT);
        write('installed', 'a.service.d/old.conf.bak', DROPIN);
        mkdirSync(join(dir, 'installed', 'b.service.d'));
        write('src', 'b.service', UNIT);
        write('installed', 'b.service', UNIT);
        const { code, out } = run();
        expect(out).toMatch(/a\.service\s+ok/);
        expect(out).toMatch(/b\.service\s+ok/);
        expect(code).toBe(0);
    });

    // The remote read is one ssh call per unit — the drop-ins come back in the
    // same call, so a shelly unit costs no extra round trip.
    test('a remote unit and its drop-ins are read in one ssh call', () => {
        write('src', 'a.service', UNIT.replace('local', 'remote-host'));
        const served = join(dir, 'served');
        writeFileSync(served, `${UNIT}@@ drop-in stale.conf @@\n${DROPIN}`);
        const stub = installSsh(dir, `cat '${served}'`);
        const { code, out } = run({ PATH: `${stub.bin}:${process.env.PATH}`, BASH_ENV: '' });
        expect(out).toMatch(/a\.service.*DRIFT.*stale\.conf/);
        expect(code).not.toBe(0);
    });
});

describe('check-nginx-drift.sh and unit drop-ins', () => {
    test('a committed <unit>.d/*.conf is not scanned as an nginx conf', () => {
        write('src', 'own.conf', '# deploy-host: local\n# deploy-as: /etc/nginx/own.conf\nlocation / { return 204; }\n');
        write('src', 'a.service.d/limits.conf', DROPIN);
        write('src', 'b.timer.d/x.conf', DROPIN);
        write('src', 'c.socket.d/y.conf', DROPIN);
        write('installed', 'etc/nginx/own.conf', 'location / { return 204; }\n');
        const { code, out } = execDriftScript(script, {
            ...process.env,
            NGINX_SRC_DIR: join(dir, 'src'),
            NGINX_ROOT_PREFIX: join(dir, 'installed'),
        });
        expect(out).not.toMatch(/limits\.conf|x\.conf|y\.conf/);
        expect(out).toMatch(/none \(1 checked\)/);
        expect(code).toBe(0);
    });
});
