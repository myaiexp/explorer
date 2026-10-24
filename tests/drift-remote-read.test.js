// @vitest-environment node
/**
 * Pins deploy/lib/read-installed.sh through both drift scripts — how a remote
 * read's outcome maps to ok / MISSING / unreachable / ERROR (idea #6279).
 *
 * ssh's ConnectTimeout starts after getaddrinfo, so a dead resolver used to
 * hold `deploy`'s post-deploy hook for as long as the lookup took. The scripts
 * now bound the whole ssh with GNU timeout, and its 124 has to read as
 * unreachable: before, every status but 255 meant "the file is not there".
 * Every case stubs ssh on PATH, so none of them performs a lookup.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execDriftScript, installSsh } from './helpers/drift-exec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Each script's seams and header shape, so one set of cases drives both.
const SCRIPTS = [
    {
        name: 'check-unit-drift.sh',
        env: (dir) => ({ UNIT_SRC_DIR: join(dir, 'src'), SYSTEMD_UNIT_DIR: join(dir, 'installed') }),
        file: (n, host) => [`u${n}.service`, `# deploy-host: ${host}\n[Service]\nExecStart=/bin/true\n`],
    },
    {
        name: 'check-nginx-drift.sh',
        env: (dir) => ({ NGINX_SRC_DIR: join(dir, 'src'), NGINX_ROOT_PREFIX: join(dir, 'installed') }),
        file: (n, host) => [
            `c${n}.conf`,
            `# deploy-host: ${host}\n# deploy-as: /etc/nginx/c${n}.conf\nlocation / { return 204; }\n`,
        ],
    },
];

describe.each(SCRIPTS)('$name remote reads', (s) => {
    const script = resolve(ROOT, 'deploy', s.name);
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'drift-remote-'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'installed'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function add(n, host = 'remote-host') {
        const [name, body] = s.file(n, host);
        writeFileSync(join(dir, 'src', name), body);
        return name;
    }

    function run(stubBody, extraEnv = {}) {
        const stub = installSsh(dir, stubBody);
        const result = execDriftScript(script, {
            ...process.env,
            ...s.env(dir),
            PATH: `${stub.bin}:${process.env.PATH}`,
            ...extraEnv,
        });
        const calls = readFileSync(stub.log, 'utf8').trim().split('\n').filter(Boolean);
        return { ...result, calls };
    }

    // The deploy path: nothing outside the script bounds it, so the script
    // has to. `exec` so the stub IS the hung process, as ssh in getaddrinfo is.
    test('a hung ssh is cut off and reported unreachable, not MISSING', () => {
        const name = add(1);
        const start = Date.now();
        const { code, out, signal } = run('exec sleep 30', { DRIFT_SSH_TIMEOUT: '1' });
        expect(signal).toBeNull();
        expect(Date.now() - start).toBeLessThan(5_000);
        expect(out).toMatch(new RegExp(`${name.replace('.', '\\.')}.*unreachable`));
        expect(out).not.toMatch(/MISSING/);
        expect(code).toBe(0);
    });

    // One timeout per dead host, not one per file: shelly carries several
    // units, and each would otherwise wait out its own bound.
    test('a host found unreachable is not dialled again for its other files', () => {
        add(1);
        add(2);
        add(3, 'other-host');
        const { code, out, calls } = run('exit 255');
        expect(calls.filter((c) => c.includes('remote-host'))).toHaveLength(1);
        expect(calls.filter((c) => c.includes('other-host'))).toHaveLength(1);
        expect(out.match(/unreachable/g)).toHaveLength(3);
        expect(code).toBe(0);
    });

    // MISSING is the remote command's own sentinel, so it means "reached the
    // host and looked", never "something went wrong somewhere".
    test('the remote sentinel 10 is MISSING and fails', () => {
        const name = add(1);
        const { code, out } = run('exit 10');
        expect(out).toMatch(new RegExp(`${name.replace('.', '\\.')}.*MISSING`));
        expect(code).not.toBe(0);
    });

    // An unreadable file, ssh missing from PATH, a bad timeout value: none of
    // those says the file is absent, and none of them is drift-neutral either.
    test('any other ssh status is an ERROR naming it, and fails', () => {
        const name = add(1);
        const { code, out } = run('exit 1');
        expect(out).toMatch(new RegExp(`${name.replace('.', '\\.')}.*ERROR.*exit 1`));
        expect(out).not.toMatch(/MISSING/);
        expect(code).not.toBe(0);
    });

    test('a reachable host serving the repo copy is ok', () => {
        const name = add(1);
        const body = s.file(1, 'remote-host')[1];
        writeFileSync(join(dir, 'served'), body);
        const { code, out } = run(`cat '${join(dir, 'served')}'`);
        expect(out).toMatch(new RegExp(`${name.replace('.', '\\.')}\\s+ok`));
        expect(code).toBe(0);
    });
});
