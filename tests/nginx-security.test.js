// @vitest-environment node
/**
 * Pins the committed nginx snippets for Wander's public surfaces.
 *
 * Live `/etc/nginx/sites-enabled/default` is edited to match these files;
 * the snippets are the reviewable source of truth (finding #7059 / #7060).
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readDeploy(name) {
    return readFileSync(resolve(ROOT, 'deploy', name), 'utf8');
}

describe('deploy/nginx-osrm-fi.conf (finding #7060)', () => {
    const conf = readDeploy('nginx-osrm-fi.conf');

    test('applies the explorer-API limit_req zone', () => {
        expect(conf).toMatch(/limit_req\s+zone=api\s+burst=10\s+nodelay;/);
    });

    test('does not wildcard-CORS the Finland OSRM proxy', () => {
        expect(conf).not.toMatch(/Access-Control-Allow-Origin\s+\*/);
        expect(conf).not.toMatch(/Access-Control-Allow-Origin\s+"\*"/);
    });
});

describe('deploy/nginx-explorer.conf (finding #7059)', () => {
    const conf = readDeploy('nginx-explorer.conf');
    // Prefix match: /explorer/api/ is longer, so these headers apply to the
    // static SPA (and its fallback) — not to the Hono API which sets its own.
    const staticBlock = conf.split(/location \/explorer\s*\{/)[1] ?? '';

    test('static /explorer sets CSP, framing, nosniff, and no-referrer', () => {
        expect(staticBlock).toMatch(/add_header\s+Content-Security-Policy\s+"[^"]*frame-ancestors 'none'/);
        expect(staticBlock).toMatch(/add_header\s+X-Frame-Options\s+"DENY"/);
        expect(staticBlock).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"/);
        expect(staticBlock).toMatch(/add_header\s+Referrer-Policy\s+"no-referrer"/);
        expect(staticBlock).toMatch(/Permissions-Policy\s+"[^"]*geolocation=\(self\)/);
    });

    test('CSP allows the page\'s real third parties and nothing via default-src *', () => {
        const m = staticBlock.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/);
        expect(m).not.toBeNull();
        const csp = m[1];
        expect(csp).toMatch(/default-src 'self'/);
        expect(csp).not.toMatch(/default-src[^;]*\*/);
        expect(csp).toMatch(/https:\/\/unpkg\.com\/leaflet@1\.9\.4\//);
        expect(csp).toMatch(/https:\/\/\*\.tile\.openstreetmap\.org/);
        expect(csp).toMatch(/https:\/\/server\.arcgisonline\.com/);
        expect(csp).toMatch(/https:\/\/overpass-api\.de/);
        expect(csp).toMatch(/https:\/\/nominatim\.openstreetmap\.org/);
        expect(csp).toMatch(/https:\/\/api\.open-meteo\.com/);
    });
});
