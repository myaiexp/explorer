// @vitest-environment node
/**
 * Pins deploy/check-nginx-drift.sh — the nginx half of idea #4018's answer
 * (idea #4047).
 *
 * check-unit-drift.sh closed the gap for systemd units. The nginx snippets have
 * the same shape and the same gap: deploy/nginx-*.conf are the reviewable source
 * of truth that tests/nginx-security.test.js reads, while the live vhost is
 * hand-edited to match and nothing compares the two. The class check on
 * 2026-09-01 found nginx-wander.conf HAD drifted — live carried
 * https://tile.openstreetmap.org in the CSP img-src that the repo copy lacked.
 *
 * The mechanism differs from the unit check, which is why it is a separate
 * script: a unit is a whole file, while most of these are FRAGMENTS embedded in
 * a shared vhost owned by every other project on the box. So the comparison is
 * comment/whitespace-normalized, and the header verb names which of the two
 * shapes a file is:
 *   `# deploy-as:   <path>`  the repo owns that whole file  → normalized equality
 *   `# deploy-into: <path>`  embedded in a bigger file      → contiguous containment
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'deploy/check-nginx-drift.sh');

// Every nginx conf committed under deploy/, at any depth. Derived from the tree
// rather than listed, so the class guard below cannot go stale the way a
// hand-kept list would — the same reason unit-drift.test.js walks the tree.
function confFiles(dir = resolve(ROOT, 'deploy'), out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) confFiles(p, out);
        else if (e.name.endsWith('.conf')) out.push(p);
    }
    return out;
}

describe('deploy/ nginx confs declare where they are installed', () => {
    test('the tree actually holds confs (a broken scan must not pass vacuously)', () => {
        expect(confFiles().length).toBeGreaterThanOrEqual(5);
    });

    test.each(confFiles().map((p) => [p.slice(ROOT.length + 1), p]))(
        '%s declares a host and exactly one install path',
        (_rel, path) => {
            const text = readFileSync(path, 'utf8');
            const host = text.match(/^#\s*deploy-host:\s*(\S+)\s*$/m);
            expect(host, 'missing a "# deploy-host: <host>" line').not.toBeNull();
            expect(host[1]).toMatch(/^[A-Za-z0-9._-]+$/);

            const into = text.match(/^#\s*deploy-into:\s*(\S+)\s*$/m);
            const as = text.match(/^#\s*deploy-as:\s*(\S+)\s*$/m);
            // Exactly one: the verb IS the comparison mode, so two would be an
            // unresolvable claim about whether the repo owns the file.
            expect(
                [into, as].filter(Boolean).length,
                'need exactly one of "# deploy-into: <path>" (fragment) or "# deploy-as: <path>" (whole file)',
            ).toBe(1);
            expect((into ?? as)[1]).toMatch(/^\/[\w./-]+$/);
        },
    );
});

describe('check-nginx-drift.sh', () => {
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'nginxdrift-'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'live', 'etc', 'nginx'), { recursive: true });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // The script's two seams: which tree to scan, and a prefix in front of every
    // declared install path so a test can drive a fixture root. Both default to
    // production (deploy/ and no prefix).
    function run() {
        try {
            const stdout = execFileSync('bash', [SCRIPT], {
                env: {
                    ...process.env,
                    NGINX_SRC_DIR: join(dir, 'src'),
                    NGINX_ROOT_PREFIX: join(dir, 'live'),
                },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { code: 0, out: stdout };
        } catch (e) {
            return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
        }
    }

    function src(name, body) {
        writeFileSync(join(dir, 'src', name), body);
    }
    function live(rel, body) {
        writeFileSync(join(dir, 'live', rel), body);
    }

    const BLOCK = 'location /api/ {\n    proxy_pass http://127.0.0.1:3700/;\n}\n';
    const FRAGMENT = `# deploy-host: local\n# deploy-into: /etc/nginx/vhost\n${BLOCK}`;
    const OWNED = `# deploy-host: local\n# deploy-as: /etc/nginx/own.conf\n${BLOCK}`;

    // A shared vhost: our fragment sits inside it, surrounded by other projects'
    // blocks and indented one level deeper than the repo copy.
    function vhost(inner = BLOCK) {
        const indented = inner
            .split('\n')
            .map((l) => (l ? `    ${l}` : l))
            .join('\n');
        return `server {\n    location /other/ { return 404; }\n\n${indented}\n    location /third/ { return 404; }\n}\n`;
    }

    test('is executable, so the deploy hook can run it', () => {
        expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
    });

    test('an empty tree fails rather than reporting a clean sweep of nothing', () => {
        const { code, out } = run();
        expect(out).toMatch(/no nginx confs found/);
        expect(code).not.toBe(0);
    });

    test('reports how many confs it checked, and checks every one', () => {
        src('a.conf', FRAGMENT);
        src('b.conf', OWNED);
        live('etc/nginx/vhost', vhost());
        live('etc/nginx/own.conf', OWNED);
        const { code, out } = run();
        expect(code).toBe(0);
        expect(out).toMatch(/none \(2 checked\)/);
    });

    describe('deploy-as — the repo owns the whole file, so equality', () => {
        test('an identical installed copy passes', () => {
            src('a.conf', OWNED);
            live('etc/nginx/own.conf', OWNED);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf\s+ok/);
            expect(code).toBe(0);
        });

        // The reason the two modes exist. Containment alone would call this fine,
        // and an add_header appended live to a file the repo claims to own is the
        // exact silent-hole shape nginx-wander-headers.conf exists to prevent.
        test('an extra directive appended live is DRIFT, not a superset that passes', () => {
            src('a.conf', OWNED);
            live('etc/nginx/own.conf', `${OWNED}add_header X-Sneaky 1;\n`);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });

        test('a changed directive is DRIFT', () => {
            src('a.conf', OWNED);
            live('etc/nginx/own.conf', OWNED.replace('3700', '9999'));
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });
    });

    describe('deploy-into — a fragment of a shared file, so containment', () => {
        test('the fragment embedded in a bigger vhost passes', () => {
            src('a.conf', FRAGMENT);
            live('etc/nginx/vhost', vhost());
            const { code, out } = run();
            expect(out).toMatch(/a\.conf\s+ok/);
            expect(code).toBe(0);
        });

        test('a changed directive inside the fragment is DRIFT', () => {
            src('a.conf', FRAGMENT);
            live('etc/nginx/vhost', vhost(BLOCK.replace('3700', '9999')));
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });

        // A directive dropped live is the drift that actually costs something —
        // the rate limit or the XFF overwrite quietly gone from the live proxy.
        test('a directive missing from the live copy is DRIFT', () => {
            src('a.conf', `# deploy-host: local\n# deploy-into: /etc/nginx/vhost\nlocation /api/ {\n    limit_req zone=api burst=10 nodelay;\n    proxy_pass http://127.0.0.1:3700/;\n}\n`);
            live('etc/nginx/vhost', vhost());
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });

        // Containment is CONTIGUOUS. The repo copy says these directives sit
        // together; a foreign directive spliced into the middle of our block is a
        // change to our block, not a neighbour.
        test('an unrelated directive spliced into the middle of the fragment is DRIFT', () => {
            src('a.conf', FRAGMENT);
            live('etc/nginx/vhost', vhost('location /api/ {\n    return 404;\n    proxy_pass http://127.0.0.1:3700/;\n}\n'));
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });
    });

    describe('normalization — what is not drift', () => {
        // The live vhost is indented one level deeper than the repo snippet
        // (it sits inside `server { }`), which is not a config change.
        test('different indentation is not drift', () => {
            src('a.conf', OWNED);
            live('etc/nginx/own.conf', OWNED.split('\n').map((l) => (l ? `\t\t${l}` : l)).join('\n'));
            const { code } = run();
            expect(code).toBe(0);
        });

        test('different comments and blank lines are not drift', () => {
            src('a.conf', OWNED);
            live('etc/nginx/own.conf', `# a totally different comment\n\n\n${BLOCK}\n# trailing note\n`);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf\s+ok/);
            expect(code).toBe(0);
        });

        // `#` only opens a comment at the start of a line or after whitespace.
        // A '#' inside a value is content, and stripping it would hide a real
        // difference in everything after it.
        test('a # inside a directive value is content, not a comment', () => {
            const withHash = '# deploy-host: local\n# deploy-as: /etc/nginx/own.conf\nadd_header X-Tag "a#keep";\n';
            src('a.conf', withHash);
            live('etc/nginx/own.conf', withHash.replace('a#keep', 'a#DIFFERENT'));
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*DRIFT/);
            expect(code).not.toBe(0);
        });
    });

    describe('declaration guards', () => {
        test('a conf that was never installed is MISSING and fails', () => {
            src('a.conf', OWNED);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*MISSING/);
            expect(code).not.toBe(0);
        });

        // Without this the scheme is opt-in, and an author who forgets the header
        // gets exactly the silence idea #4018 is about.
        test('a conf with no deploy-host header fails rather than being skipped', () => {
            src('a.conf', `# deploy-into: /etc/nginx/vhost\n${BLOCK}`);
            live('etc/nginx/vhost', vhost());
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*UNDECLARED/i);
            expect(code).not.toBe(0);
        });

        test('a conf with no install path fails', () => {
            src('a.conf', `# deploy-host: local\n${BLOCK}`);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*UNDECLARED/i);
            expect(code).not.toBe(0);
        });

        // Two verbs is an unresolvable claim about whether the repo owns the file,
        // and picking one silently would pick the weaker comparison half the time.
        test('a conf declaring both deploy-into and deploy-as fails', () => {
            src('a.conf', `# deploy-host: local\n# deploy-into: /etc/nginx/vhost\n# deploy-as: /etc/nginx/own.conf\n${BLOCK}`);
            live('etc/nginx/vhost', vhost());
            live('etc/nginx/own.conf', OWNED);
            const { code, out } = run();
            expect(out).toMatch(/a\.conf.*UNDECLARED/i);
            expect(code).not.toBe(0);
        });
    });

    test('scans nested directories — shelly-osrm/ and shelly-overpass/ live there', () => {
        mkdirSync(join(dir, 'src', 'shelly-thing'));
        writeFileSync(join(dir, 'src', 'shelly-thing', 'n.conf'), OWNED);
        const { code, out } = run();
        expect(out).toMatch(/n\.conf.*MISSING/);
        expect(code).not.toBe(0);
    });

    test('an unreachable host warns without failing — an ssh outage is not drift', () => {
        src('a.conf', `# deploy-host: no-such-host-for-wander\n# deploy-as: /etc/nginx/own.conf\n${BLOCK}`);
        const { code, out } = run();
        expect(out).toMatch(/a\.conf.*unreachable/i);
        expect(code).toBe(0);
    });

    test('one drifted conf still fails a run where others are fine', () => {
        src('a.conf', OWNED);
        src('b.conf', FRAGMENT);
        live('etc/nginx/own.conf', OWNED);
        live('etc/nginx/vhost', vhost(BLOCK.replace('3700', '9999')));
        const { code, out } = run();
        expect(out).toMatch(/a\.conf\s+ok/);
        expect(out).toMatch(/b\.conf.*DRIFT/);
        expect(code).not.toBe(0);
    });
});
