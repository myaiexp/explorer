// Pins deploy/wander-junctions.service isolation + trusted-proxy env
// (findings #7755 / #7754).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unit = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../deploy/wander-junctions.service'),
    'utf8',
);

describe('deploy/wander-junctions.service sandbox (finding #7755)', () => {
    test('runs as a dedicated nologin user, not the interactive shelly account', () => {
        expect(unit).toMatch(/^User=wander-junctions$/m);
        expect(unit).toMatch(/^Group=wander-junctions$/m);
        expect(unit).not.toMatch(/^User=shelly$/m);
    });

    test('keeps the cache out of /home/shelly', () => {
        expect(unit).toMatch(/^StateDirectory=wander-junctions$/m);
        expect(unit).toMatch(/CACHE_PATH=\/var\/lib\/wander-junctions\/cache\.json/);
        expect(unit).not.toMatch(/CACHE_PATH=\/home\/shelly\//);
    });

    test('keeps the start-anchored snapshot unreadable by other local uids (finding #12871)', () => {
        // systemd's defaults are StateDirectoryMode=0755 and UMask=0022, and a
        // start resets the directory to that mode — the installer's chmod does
        // not survive. The keys are walker starts at ~111 m.
        expect(unit).toMatch(/^StateDirectoryMode=0750$/m);
        expect(unit).toMatch(/^UMask=0077$/m);
    });

    test('hides /home except the junctions-cache tree and enables the hardening block', () => {
        expect(unit).toMatch(/^ProtectSystem=strict$/m);
        expect(unit).toMatch(/^ProtectHome=tmpfs$/m);
        expect(unit).toMatch(/^PrivateTmp=yes$/m);
        expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
        expect(unit).toMatch(/BindReadOnlyPaths=\/home\/shelly\/Projects\/wander\/junctions-cache/);
        expect(unit).toMatch(/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
    });

    test('caps process memory so a fat Overpass dump cannot OOM the host', () => {
        expect(unit).toMatch(/^MemoryMax=512M$/m);
    });
});

describe('deploy/wander-junctions.service TRUSTED_PROXIES (finding #7754)', () => {
    test('trusts the VPS Tailscale IPv4 so nginx X-Real-IP / last XFF hop is the client key', () => {
        expect(unit).toMatch(/^Environment=TRUSTED_PROXIES=100\.117\.202\.73$/m);
    });

    test('does not put loopback in TRUSTED_PROXIES — nothing local proxies', () => {
        const line = unit.split('\n').find((l) => l.startsWith('Environment=TRUSTED_PROXIES='));
        expect(line).toBeDefined();
        expect(line).not.toMatch(/127\.0\.0\.1/);
        expect(line).not.toMatch(/::1/);
    });
});

describe('deploy/install-wander-junctions.sh snapshot mode (finding #12871)', () => {
    const script = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../deploy/install-wander-junctions.sh'),
        'utf8',
    );

    test('locks the directory and the existing snapshot, not only the directory', () => {
        // StateDirectoryMode fixes the directory on the next start. A snapshot
        // already on disk keeps the mode it was created with until rewritten,
        // so the installer has to chmod the file too. Both existence checks
        // are root's: once the directory is 0750 the installing user cannot
        // stat the file, so a plain `-f` skips the chmod and can also make
        // the migration copy look like the snapshot is missing.
        expect(script).toMatch(/chmod 0750 "\$STATE_DIR"/);
        expect(script).toMatch(/sudo test -f "\$STATE_DIR\/cache\.json"/);
        expect(script).toMatch(/chmod 0600 "\$STATE_DIR\/cache\.json"/);
        const privileged = script.match(/sudo test -f "\$STATE_DIR\/cache\.json"/g) ?? [];
        expect(privileged).toHaveLength(2);
    });
});
