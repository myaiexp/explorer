// @vitest-environment node
/**
 * Pins deploy/shelly-osrm/osrm-refresh.sh and the osrm-foot.service contract
 * it feeds (idea #6517).
 *
 * osrm-routed accepts a dataset only when its major.minor matches the binary
 * that built it. The native AUR binary and the weekly dataset moved on separate
 * schedules — pacman at 04:00 or a reboot could start a newer binary on the old
 * graph and crash-loop it, which is why shelly sat on IgnorePkg. The fix makes
 * every set carry the image that built it (osrm.env, written last), and the
 * unit serve whatever `current`'s stamp names, so the two can only move together.
 *
 * Driven through PATH stubs for docker, runuser, systemctl, curl, wget and id,
 * against a fixture data root (the OSRM_DATA_ROOT seam).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
    rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'deploy/shelly-osrm/osrm-refresh.sh');
const UNIT = resolve(ROOT, 'deploy/shelly-osrm/osrm-foot.service');
const DIGEST_REF = 'ghcr.io/project-osrm/osrm-backend@sha256:feed';

const pinnedImage = () => readFileSync(SCRIPT, 'utf8').match(/^IMAGE=(\S+)$/m)?.[1];

const STUBS = {
    docker: `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  image) case "$*" in *--format*) echo "${DIGEST_REF}";; esac; exit 0;;
  pull) exit 0;;
  run)
    data=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "-v" ]; then case "$a" in *:/data*) data=\${a%%:/data*};; esac; fi
      prev=$a
    done
    case "$*" in
      *osrm-extract*) [ -n "$STUB_FAIL_EXTRACT" ] && exit 1; : > "$data/finland-latest.osrm";;
      *--trial*) [ -n "$STUB_FAIL_TRIAL" ] && exit 1;;
    esac
    exit 0;;
esac
exit 0
`,
    runuser: '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    // STUB_FAIL_FIRST_RESTART: the first restart fails, later ones succeed.
    systemctl: `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$STUB_LOG"
if [ -n "$STUB_FAIL_FIRST_RESTART" ] && [ ! -e "$STUB_LOG.restarted" ]; then : > "$STUB_LOG.restarted"; exit 1; fi
exit 0
`,
    curl: '#!/bin/sh\n[ -n "$STUB_FAIL_SMOKE" ] && exit 22\necho \'{"code":"Ok","routes":[]}\'\n',
    wget: '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-O" ] && { shift; echo pbf > "$1"; }; shift; done\n',
    id: '#!/bin/sh\necho 957\n',
};

describe('osrm-refresh.sh', () => {
    let dir, processed, log;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'osrm-refresh-'));
        processed = join(dir, 'data', 'processed');
        mkdirSync(processed, { recursive: true });
        mkdirSync(join(dir, 'data', 'pbf'));
        mkdirSync(join(dir, 'bin'));
        for (const [name, body] of Object.entries(STUBS)) {
            writeFileSync(join(dir, 'bin', name), body, { mode: 0o755 });
        }
        log = join(dir, 'calls.log');
        writeFileSync(log, '');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // `wrap` prefixes the command, e.g. a flock holding the refresh lock.
    function run(args = [], env = {}, wrap = []) {
        try {
            const [cmd, ...rest] = [...wrap, 'bash', SCRIPT, ...args];
            const out = execFileSync(cmd, rest, {
                env: {
                    ...process.env,
                    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
                    OSRM_DATA_ROOT: join(dir, 'data'),
                    OSRM_SMOKE_TRIES: '2',
                    OSRM_SMOKE_INTERVAL: '0',
                    STUB_LOG: log,
                    ...env,
                },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 10_000,
            });
            return { code: 0, out };
        } catch (e) {
            return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
        }
    }

    // A processed set; `pin` writes the stamp a finished refresh leaves behind.
    function set(name, { pin = null } = {}) {
        mkdirSync(join(processed, name));
        writeFileSync(join(processed, name, 'finland-latest.osrm'), '');
        if (pin) {
            writeFileSync(
                join(processed, name, 'osrm.env'),
                `OSRM_IMAGE=${DIGEST_REF}\nOSRM_IMAGE_PIN=${pin}\nOSRM_SET=${name}\n`,
            );
        }
    }
    const point = (name) => symlinkSync(name, join(processed, 'current'));
    const current = () => readlinkSync(join(processed, 'current'));
    const sets = () => readdirSync(processed).filter((n) => n !== 'current').sort();
    const calls = () => readFileSync(log, 'utf8');

    test('pins an image', () => {
        expect(pinnedImage()).toMatch(/^ghcr\.io\/project-osrm\/osrm-backend:v\d+\.\d+\.\d+/);
    });

    describe('--check', () => {
        test('stale when there is no current set', () => {
            expect(run(['--check']).code).toBe(3);
        });

        test('stale when the current set has no stamp (built by an unrecorded binary)', () => {
            set('20261018T000003Z');
            point('20261018T000003Z');
            expect(run(['--check']).code).toBe(3);
        });

        test('stale when the current set was built by another image', () => {
            set('20261018T000003Z', { pin: 'ghcr.io/project-osrm/osrm-backend:v26.8.0-debian' });
            point('20261018T000003Z');
            expect(run(['--check']).code).toBe(3);
        });

        test('fresh when the current set was built by the pinned image', () => {
            set('20261018T000003Z', { pin: pinnedImage() });
            point('20261018T000003Z');
            const { code, out } = run(['--check']);
            expect(out).toMatch(/built by/);
            expect(code).toBe(0);
        });
    });

    test('a refresh stamps the new set with the digest that built it, then swaps and restarts', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const { code, out } = run();
        expect(code, out).toBe(0);

        const fresh = current();
        expect(fresh).not.toBe('20200101T000000Z');
        const stamp = readFileSync(join(processed, fresh, 'osrm.env'), 'utf8');
        expect(stamp).toContain(`OSRM_IMAGE=${DIGEST_REF}\n`);
        expect(stamp).toContain(`OSRM_IMAGE_PIN=${pinnedImage()}\n`);
        expect(stamp).toContain(`OSRM_SET=${fresh}\n`);
        // .fileIndex comes out of osrm-extract as 0700, so the set is served as its owner.
        expect(stamp).toContain('OSRM_USER=957:957\n');
        // Every build step ran from the digest, and the set was load-tested by it.
        for (const step of ['osrm-extract', 'osrm-partition', 'osrm-customize', 'osrm-routed']) {
            expect(calls()).toMatch(new RegExp(`run .*${DIGEST_REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${step}`));
        }
        // The trial load runs in the unit's shape: read-only data, owner uid, no caps.
        const trial = calls().split('\n').find((l) => l.includes('--trial'));
        for (const token of ['--read-only', '--user 957:957', '--cap-drop ALL', ':/data:ro ', '--trial=1 ']) {
            expect(trial).toContain(token);
        }
        expect(calls()).toMatch(/systemctl restart osrm-foot\.service/);
    });

    test('GC keeps current plus the newest finished set, and drops unstamped leftovers', () => {
        set('20200101T000000Z', { pin: pinnedImage() }); // oldest finished: goes
        set('20200108T000000Z', { pin: pinnedImage() }); // previous current: rollback target, stays
        set('20991231T000000Z'); // a refresh killed mid-build sorts newest: must not count
        point('20200108T000000Z');
        const { code, out } = run();
        expect(code, out).toBe(0);
        expect(sets()).toEqual(['20200108T000000Z', current()].sort());
    });

    test('a set the image cannot load is never stamped or swapped in', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const { code } = run([], { STUB_FAIL_TRIAL: '1' });
        expect(code).not.toBe(0);
        expect(current()).toBe('20200101T000000Z');
        expect(sets()).toEqual(['20200101T000000Z']);
        expect(calls()).not.toMatch(/systemctl restart/);
    });

    test('a failed build leaves current alone and removes its staging set', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const { code } = run([], { STUB_FAIL_EXTRACT: '1' });
        expect(code).not.toBe(0);
        expect(current()).toBe('20200101T000000Z');
        expect(sets()).toEqual(['20200101T000000Z']);
        expect(existsSync(join(dir, 'data', 'pbf', 'staging.osm.pbf'))).toBe(false);
    });

    test('a failed smoke check rolls back to the previous finished set', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const { code } = run([], { STUB_FAIL_SMOKE: '1' });
        expect(code).not.toBe(0);
        expect(current()).toBe('20200101T000000Z');
        expect(sets()).toEqual(['20200101T000000Z']);
        expect(calls().match(/systemctl restart osrm-foot\.service/g)).toHaveLength(2);
    });

    test('a failed restart rolls back too, not just a failed smoke check', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const { code } = run([], { STUB_FAIL_FIRST_RESTART: '1' });
        expect(code).not.toBe(0);
        expect(current()).toBe('20200101T000000Z');
        expect(sets()).toEqual(['20200101T000000Z']);
    });

    // GC deletes every unstamped set, so a second run alongside the timer's
    // would delete the first one's staging set from under it.
    test('refuses to run while another refresh holds the lock', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        const lock = join(dir, 'data', '.refresh.lock');
        const { code, out } = run([], {}, ['flock', lock]);
        expect(out).toMatch(/another refresh is running/);
        expect(code).not.toBe(0);
        expect(calls()).not.toMatch(/docker run/);
    });

    test('--check does not need the lock', () => {
        set('20200101T000000Z', { pin: pinnedImage() });
        point('20200101T000000Z');
        expect(run(['--check'], {}, ['flock', join(dir, 'data', '.refresh.lock')]).code).toBe(0);
    });

    test('with no finished set to roll back to, the new set stays current and is kept', () => {
        set('20200101T000000Z'); // pre-stamp set, e.g. the native-binary era
        point('20200101T000000Z');
        const { code } = run([], { STUB_FAIL_SMOKE: '1' });
        expect(code).not.toBe(0);
        const fresh = current();
        expect(fresh).not.toBe('20200101T000000Z');
        expect(existsSync(join(processed, fresh, 'osrm.env'))).toBe(true);
    });
});

describe('osrm-foot.service serves each set with the image that built it', () => {
    const unit = readFileSync(UNIT, 'utf8');

    test('reads the image and the set from current\'s stamp', () => {
        // No leading `-`: an unstamped set must refuse to start, not be guessed at.
        expect(unit).toMatch(/^EnvironmentFile=\/srv\/osrm\/finland\/processed\/current\/osrm\.env$/m);
        expect(unit).toContain('/srv/osrm/finland/processed/${OSRM_SET}:/data:ro');
        expect(unit).toMatch(/^\s+\$\{OSRM_IMAGE\} \\$/m);
        expect(unit).toMatch(/--user \$\{OSRM_USER\}/);
    });

    // The trial load exists to fail where the unit would. A sandbox flag added
    // to the unit and not to the trial would let a set pass that cannot serve.
    test('the refresh trial-loads with every container flag the unit serves with', () => {
        const execStart = unit.match(/^ExecStart=([\s\S]*?[^\\])$/m)[1];
        const flags = execStart.match(/--[a-z-]+(?: [^-\s/\\][^\s\\]*)?/g)
            .filter((f) => !/^--(rm|name|network|memory|algorithm|ip|port)\b/.test(f));
        expect(flags.length).toBeGreaterThanOrEqual(4);
        const script = readFileSync(SCRIPT, 'utf8');
        const end = script.indexOf('osrm-routed --algorithm mld --trial=1');
        const trial = script.slice(script.lastIndexOf('docker run', end), end);
        for (const flag of flags) expect(trial).toContain(flag.replace('${OSRM_USER}', '"$OSRM_IDS"'));
        expect(trial).toContain(':/data:ro');
    });

    test('names no image of its own', () => {
        expect(unit).not.toMatch(/osrm-backend[:@]/);
        expect(unit).not.toMatch(/\/usr\/bin\/osrm-routed/);
    });
});
