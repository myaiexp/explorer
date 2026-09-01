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

/**
 * The body of one `location <path> { … }` block.
 *
 * Matches the location header exactly, so `/wander` does not also match
 * `/wander/api/` — nginx-wander.conf holds four blocks whose paths are
 * prefixes of each other, and the old `conf.split(...)[1]` could not tell
 * them apart.
 */
function blockFor(conf, path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const open = new RegExp(`location\\s+${escaped}\\s*\\{`, 'g');
    const m = open.exec(conf);
    if (!m) return '';
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < conf.length; i++) {
        if (conf[i] === '{') depth++;
        else if (conf[i] === '}' && --depth === 0) return conf.slice(m.index + m[0].length, i);
    }
    return '';
}

/**
 * Just the directives — `#` comment lines dropped.
 *
 * Comments here name the thing they are warning against
 * (`$proxy_add_x_forwarded_for`, `add_header`), so an assertion that a config
 * does NOT do something has to read past them or it fails on its own
 * explanation.
 */
function directivesOf(text) {
    return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** The CSP value out of the shared header snippet. */
function cspFrom(headers) {
    return (headers.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/) || [])[1] ?? '';
}

describe('deploy/nginx-osrm-fi.conf (finding #7060)', () => {
    const conf = readDeploy('nginx-osrm-fi.conf');

    test('applies the wander-API limit_req zone', () => {
        expect(conf).toMatch(/limit_req\s+zone=api\s+burst=10\s+nodelay;/);
    });

    test('does not wildcard-CORS the Finland OSRM proxy', () => {
        expect(conf).not.toMatch(/Access-Control-Allow-Origin\s+\*/);
        expect(conf).not.toMatch(/Access-Control-Allow-Origin\s+"\*"/);
    });
});

describe('deploy/nginx-wander-headers.conf (finding #7059)', () => {
    // The header/CSP contract is asserted ONCE, against the shared snippet.
    // Prefix match: /wander/api/ is longer than /wander, so these headers apply
    // to the static SPA (and its fallback) — not to the Hono API, which sets
    // its own.
    const headers = readDeploy('nginx-wander-headers.conf');

    test('sets CSP, framing, nosniff, and Permissions-Policy', () => {
        expect(headers).toMatch(/add_header\s+Content-Security-Policy\s+"[^"]*frame-ancestors 'none'/);
        expect(headers).toMatch(/add_header\s+X-Frame-Options\s+"DENY"/);
        expect(headers).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"/);
        expect(headers).toMatch(/Permissions-Policy\s+"[^"]*geolocation=\(self\)/);
    });

    test('Referrer-Policy still sends an origin — no-referrer blanks the OSM map', () => {
        const m = headers.match(/add_header\s+Referrer-Policy\s+"([^"]+)"/);
        expect(m).not.toBeNull();
        // OSM's tile usage policy answers a Referer-less request with a "403r
        // Access blocked" tile (HTTP 200, so nothing errors — the map just
        // turns into grey warning squares). "no-referrer" and "same-origin"
        // both strip it from every tile <img>; the origin-only policies hand
        // OSM https://mase.fi/ and leak no path, query or fragment — so the
        // /wander/<username> path and the #t=<token> secret stay private.
        expect(['strict-origin', 'strict-origin-when-cross-origin']).toContain(m[1]);
    });

    test('CSP allows the page\'s real third parties and nothing via default-src *', () => {
        const csp = cspFrom(headers);
        expect(csp).not.toBe('');
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
});

describe('deploy/nginx-wander.conf static blocks', () => {
    const conf = readDeploy('nginx-wander.conf');

    // nginx add_header is all-or-nothing per context, so a block that grew its
    // own copy of the header set would silently shadow the shared one — the
    // weaker of the two wins for whoever is using that prefix, with no error.
    test.each(['/wander', '/explorer'])('%s includes the shared header snippet and carries no add_header of its own', (path) => {
        const block = blockFor(conf, path);
        expect(block).not.toBe('');
        expect(block).toMatch(/include\s+\S*wander-headers\.conf;/);
        expect(directivesOf(block)).not.toMatch(/add_header/);
    });

    test.each(['/wander', '/explorer'])('%s serves the wander webroot', (path) => {
        expect(blockFor(conf, path)).toMatch(/alias\s+\/var\/www\/html\/wander;/);
    });

    // Cloud-backup links are /<prefix>/<username>#t=<token>. Dropping try_files
    // serves a 404 instead of index.html, so the SPA never reads
    // location.pathname. The committed snippet is the reviewable source of
    // truth — live nginx is copied from it (finding #7582).
    test('/wander falls back to its own index', () => {
        expect(blockFor(conf, '/wander')).toMatch(/^\s*try_files\s+\$uri\s+\$uri\/\s+\/wander\/index\.html;/m);
    });

    test('/explorer falls back to its own index so the SPA still boots on the old path', () => {
        expect(blockFor(conf, '/explorer')).toMatch(/^\s*try_files\s+\$uri\s+\$uri\/\s+\/explorer\/index\.html;/m);
    });

    test('blockFor tells the static block from its API sibling', () => {
        // Guards the helper itself: `location /wander` is a prefix of
        // `location /wander/api/`, and the old split-on-substring approach
        // matched the wrong one.
        expect(blockFor(conf, '/wander')).toMatch(/alias/);
        expect(blockFor(conf, '/wander')).not.toMatch(/proxy_pass/);
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

describe('deploy/nginx-wander.conf API proxies (finding #7582)', () => {
    const conf = readDeploy('nginx-wander.conf');

    // Both proxies are pinned, not just the canonical one: /explorer/api/ is
    // permanent, so a rate-limit or XFF regression there is just as live.
    test.each(['/wander/api/', '/explorer/api/'])('%s is pinned to the wander-api upstream, rate-limited, and does not trust client XFF', (path) => {
        const block = blockFor(conf, path);
        expect(block).not.toBe('');
        expect(block).toMatch(/^\s*limit_req\s+zone=api\s+burst=10\s+nodelay;/m);
        expect(block).toMatch(/^\s*proxy_pass\s+http:\/\/127\.0\.0\.1:3700\/api\/;/m);
        expect(block).toMatch(/^\s*proxy_set_header\s+X-Real-IP\s+\$remote_addr;/m);
        // Overwrite, do not append — client-supplied XFF hops must not become
        // the rate-limit key (finding #7895).
        expect(block).toMatch(/^\s*proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/m);
        expect(directivesOf(block)).not.toMatch(/\$proxy_add_x_forwarded_for/);
    });
});


describe('CSP img-src covers every tile host map-view.js can request', () => {
    // Sibling of the connect-src scan below, and of the same failure shape:
    // a tile host the CSP does not list is refused with only a console
    // violation — the map turns grey and nothing throws. `{s}` is the sharp
    // case: `https://*.tile.openstreetmap.org` matches `a.tile...` but NOT
    // the bare `tile.openstreetmap.org`, so dropping Leaflet's deprecated
    // subdomain placeholder (which OSM operations and Leaflet's own docs now
    // steer clients toward) blanks every tile. Both forms are allowed so the
    // switch is a one-line edit in map-view.js, not a silent outage.
    const csp = cspFrom(readDeploy('nginx-wander-headers.conf'));
    const imgSrc = (csp.match(/img-src ([^;]*)/) || [])[1] ?? '';

    function tileHosts() {
        const src = readFileSync(resolve(ROOT, 'map-view.js'), 'utf8');
        return [...new Set(
            [...src.matchAll(/L\.tileLayer\(\s*'https:\/\/([^/']+)/g)].map((m) => m[1])
        )];
    }

    test('every tile host is allowed by img-src, with and without {s}', () => {
        const missing = [];
        for (const host of tileHosts()) {
            // `{s}.example.org` needs the wildcard for Leaflet's a/b/c
            // expansion AND the bare host for the no-placeholder form.
            const bare = host.replace(/^\{s\}\./, '');
            const needed = host === bare ? [`https://${bare}`] : [`https://*.${bare}`, `https://${bare}`];
            for (const token of needed) {
                if (!imgSrc.split(/\s+/).includes(token)) missing.push(`${token} (${host})`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('the scan sees real tile layers, so it cannot pass vacuously', () => {
        expect(imgSrc).not.toBe('');
        expect(tileHosts()).toContain('{s}.tile.openstreetmap.org');
        expect(tileHosts()).toContain('server.arcgisonline.com');
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

    const csp = cspFrom(readDeploy('nginx-wander-headers.conf'));
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
