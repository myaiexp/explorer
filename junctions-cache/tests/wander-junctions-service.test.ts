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

    test('hides /home except the junctions-cache tree and enables the hardening block', () => {
        expect(unit).toMatch(/^ProtectSystem=strict$/m);
        expect(unit).toMatch(/^ProtectHome=tmpfs$/m);
        expect(unit).toMatch(/^PrivateTmp=yes$/m);
        expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
        expect(unit).toMatch(/BindReadOnlyPaths=\/home\/shelly\/Projects\/explorer\/junctions-cache/);
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
