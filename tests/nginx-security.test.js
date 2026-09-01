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

    test('static /explorer sets CSP, framing, nosniff, and Permissions-Policy', () => {
        expect(staticBlock).toMatch(/add_header\s+Content-Security-Policy\s+"[^"]*frame-ancestors 'none'/);
        expect(staticBlock).toMatch(/add_header\s+X-Frame-Options\s+"DENY"/);
        expect(staticBlock).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"/);
        expect(staticBlock).toMatch(/Permissions-Policy\s+"[^"]*geolocation=\(self\)/);
    });

    test('Referrer-Policy still sends an origin — no-referrer blanks the OSM map', () => {
        const m = staticBlock.match(/add_header\s+Referrer-Policy\s+"([^"]+)"/);
        expect(m).not.toBeNull();
        // OSM's tile usage policy answers a Referer-less request with a "403r
        // Access blocked" tile (HTTP 200, so nothing errors — the map just
        // turns into grey warning squares). "no-referrer" and "same-origin"
        // both strip it from every tile <img>; the origin-only policies hand
        // OSM https://mase.fi/ and leak no path, query or fragment — so the
        // /explorer/<username> path and the #t=<token> secret stay private.
        expect(['strict-origin', 'strict-origin-when-cross-origin']).toContain(m[1]);
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
        // No overpass-api.de: POI/road pools are same-origin POSTs to
        // /api/junctions/*, already covered by connect-src 'self'.
        expect(csp).toMatch(/https:\/\/nominatim\.openstreetmap\.org/);
        expect(csp).toMatch(/https:\/\/api\.open-meteo\.com/);
    });

    test('static /explorer keeps the SPA try_files fallback for /explorer/<username>', () => {
        // Cloud-backup links are /explorer/<username>#t=<token>. Dropping
        // try_files serves a 404 instead of index.html, so the SPA never
        // reads location.pathname. The committed snippet is the reviewable
        // source of truth — live nginx is copied from it (finding #7582).
        expect(staticBlock).toMatch(/^\s*try_files\s+\$uri\s+\$uri\/\s+\/explorer\/index\.html;/m);
    });
});

describe('deploy/nginx-junctions.conf (finding #7559)', () => {
    const conf = readDeploy('nginx-junctions.conf');
    const logFmt = readDeploy('nginx-junctions-log-format.conf');

    test('proxies /api/junctions/ to the shelly cache with the api limit_req zone', () => {
        expect(conf).toMatch(/location \/api\/junctions\//);
        expect(conf).toMatch(/limit_req\s+zone=api\b/);
        expect(conf).toMatch(/proxy_pass\s+http:\/\/100\.69\.160\.113:5001\//);
        expect(conf).toMatch(/proxy_read_timeout\s+60s;/);
    });

    test('access_log uses the path-only format so query strings cannot persist coords', () => {
        expect(conf).toMatch(/access_log\s+\S+\s+junctions_no_qs;/);
        expect(logFmt).toMatch(/log_format\s+junctions_no_qs/);
        // Only the format string is the log line — comments may name $request
        // as the thing we are *not* logging.
        const formatLines = logFmt.split('\n').filter((l) => /^\s*log_format|^\s+'/.test(l)).join('\n');
        expect(formatLines).toMatch(/\$request_method \$uri \$server_protocol/);
        expect(formatLines).not.toMatch(/\$request_uri/);
        expect(formatLines).not.toMatch(/\$request[^_m]/);
    });

    test('caps POST bodies so the proxy cannot be used as a large-body dump', () => {
        expect(conf).toMatch(/client_max_body_size\s+16k;/);
    });

    test('overwrites X-Forwarded-For with $remote_addr so client hops cannot key rate limits (finding #7895)', () => {
        const locMatch = conf.match(/location \/api\/junctions\/\s*\{([^}]+)\}/);
        const block = locMatch ? locMatch[1] : '';
        expect(locMatch).not.toBeNull();
        expect(block).toMatch(/^\s*proxy_set_header\s+X-Real-IP\s+\$remote_addr;/m);
        expect(block).toMatch(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/m);
        expect(block).not.toMatch(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/m);
    });
});

describe('deploy/nginx-explorer.conf API proxy (finding #7582)', () => {
    const conf = readDeploy('nginx-explorer.conf');
    const apiMatch = conf.match(/location \/explorer\/api\/\s*\{([^}]+)\}/);
    const apiBlock = apiMatch ? apiMatch[1] : '';

    test('pins the /explorer/api/ location to the explorer-api upstream', () => {
        expect(apiMatch).not.toBeNull();
        expect(apiBlock).toMatch(/^\s*limit_req\s+zone=api\b/m);
        expect(apiBlock).toMatch(/^\s*proxy_pass\s+http:\/\/127\.0\.0\.1:3700\/api\/;/m);
        expect(apiBlock).toMatch(/^\s*proxy_set_header\s+X-Real-IP\s+\$remote_addr;/m);
        // Overwrite, do not append — client-supplied XFF hops must not become
        // the rate-limit key (finding #7895).
        expect(apiBlock).toMatch(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/m);
        expect(apiBlock).not.toMatch(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/m);
    });
});


describe('CSP connect-src covers every host the app actually fetches', () => {
    // The public-OSRM fallback shipped inert: osrm.js fetched
    // routing.openstreetmap.de, connect-src did not list it, and the browser
    // blocked every request with "TypeError: Failed to fetch". Unit tests
    // passed and a local dev server (which sends no CSP) passed — only prod
    // failed. Deriving the host list from the source is what closes that gap:
    // adding a fetch to a new host now fails here until the CSP catches up.
    const FETCHING_MODULES = [
        'osrm.js',
        'overpass.js',
        'elevation.js',
        'location-input.js',
        'sync.js',
    ];

    const conf = readDeploy('nginx-explorer.conf');
    const staticBlock = conf.split(/location \/explorer\s*\{/)[1] ?? '';
    const csp = (staticBlock.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/) || [])[1] ?? '';
    const connectSrc = (csp.match(/connect-src ([^;]*)/) || [])[1] ?? '';

    function hostsIn(file) {
        const src = readFileSync(resolve(ROOT, file), 'utf8');
        return [...new Set([...src.matchAll(/https:\/\/([a-zA-Z0-9._-]+)/g)].map((m) => m[1]))];
    }

    test('every fetched host is allowed by connect-src', () => {
        const missing = [];
        for (const file of FETCHING_MODULES) {
            for (const host of hostsIn(file)) {
                // The app's own origin is covered by 'self'.
                if (host === 'mase.fi') continue;
                if (!connectSrc.includes(`https://${host}`)) missing.push(`${host} (${file})`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('the scan sees real hosts, so it cannot pass vacuously', () => {
        expect(connectSrc).not.toBe('');
        expect(hostsIn('osrm.js')).toContain('routing.openstreetmap.de');
        // Anchored on elevation.js since overpass.js stopped naming a third
        // party (its pools are same-origin now). This assertion is why the
        // scan above cannot pass by scanning nothing, so it must always point
        // at a module that really does fetch a cross-origin host — re-anchor
        // it, never delete it.
        expect(hostsIn('elevation.js')).toContain('api.open-meteo.com');
    });
});
