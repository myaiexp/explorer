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
    // Spaces in a matcher (`^~ /explorer/`, `= /explorer`) become \s+ so the
    // lookup does not depend on the file's exact spacing.
    const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ +/g, '\\s+');
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

/**
 * Whitespace-separated tokens of one directive.
 *
 * `script-src` does not match `script-src-elem`, and a token is not a
 * substring of a longer one: `https://api.open-meteo.com/wrong` does not
 * count as allowing `https://api.open-meteo.com` (finding #12672).
 */
function cspTokens(csp, directive) {
    const body = (csp.match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]*)`)) || [])[1] ?? '';
    return body.split(/\s+/).filter(Boolean);
}

/**
 * CSP host-source path match (CSP3). An empty path or `/` allows any path on
 * that host; a path ending in `/` is a prefix; anything else matches the path
 * exactly. Query and fragment are ignored.
 *
 * index.html asks for `…/leaflet@1.9.4/dist/leaflet.js`. The live allowlist
 * token is the version directory `https://unpkg.com/leaflet@1.9.4/`, which
 * is a prefix of that file — not the file URL itself. Exact URL equality
 * would fail the header that actually allows the request.
 */
function tokenAllowsUrl(token, url) {
    let tokenUrl;
    let target;
    try {
        tokenUrl = new URL(token);
        target = new URL(url);
    } catch {
        return false;
    }
    if (tokenUrl.protocol !== target.protocol || tokenUrl.hostname !== target.hostname) return false;
    if (tokenUrl.port !== target.port) return false;
    const tokenPath = tokenUrl.pathname;
    if (tokenPath === '' || tokenPath === '/') return true;
    if (tokenPath.endsWith('/')) return target.pathname.startsWith(tokenPath);
    return target.pathname === tokenPath;
}

function isAbsoluteHttp(url) {
    return /^https?:\/\//.test(url);
}

/** URLs the directive does not allow. Same-origin references need `'self'`. */
function urlsMissingFrom(csp, directive, urls) {
    const tokens = cspTokens(csp, directive);
    const missing = [];
    for (const url of urls) {
        if (isAbsoluteHttp(url)) {
            if (!tokens.some((token) => tokenAllowsUrl(token, url))) missing.push(url);
        } else if (!tokens.includes("'self'")) {
            missing.push(url);
        }
    }
    return missing;
}

/** Hosts with no exact `https://<host>` token on connect-src. */
function hostsMissingFromConnect(csp, hosts) {
    const tokens = cspTokens(csp, 'connect-src');
    return hosts.filter((host) => host !== 'mase.fi' && !tokens.includes(`https://${host}`));
}

/** Stylesheet hrefs and script srcs from index.html, in document order. */
function pageResources() {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? '';
    const scripts = [];
    const styles = [];
    for (const m of html.matchAll(/<script\b[^>]*>/g)) {
        const src = attr(m[0], 'src');
        if (src) scripts.push(src);
    }
    for (const m of html.matchAll(/<link\b[^>]*>/g)) {
        if (attr(m[0], 'rel') !== 'stylesheet') continue;
        const href = attr(m[0], 'href');
        if (href) styles.push(href);
    }
    return { scripts, styles };
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
        // Hosts are exact tokens on the directive that serves them. A
        // header-wide regex stays green when the same string sits on img-src
        // only, or when a longer token merely contains the host (finding #12672).
        // Leaflet's script and stylesheet are read from index.html below.
        const img = cspTokens(csp, 'img-src');
        const connect = cspTokens(csp, 'connect-src');
        expect(img).toContain('https://*.tile.openstreetmap.org');
        expect(img).toContain('https://server.arcgisonline.com');
        // No overpass-api.de: POI/road pools are same-origin POSTs to
        // /api/junctions/*, already covered by connect-src 'self'.
        expect(connect).toContain('https://nominatim.openstreetmap.org');
        expect(connect).toContain('https://api.open-meteo.com');
    });

    test('CSP does not allow the Cloudflare beacon (finding #12872)', () => {
        // The apex sub_filter injects an unpinned beacon.min.js into every HTML
        // response. This page holds the backup bearer, so the header must not
        // name either beacon host — on any directive, not only script-src.
        const csp = cspFrom(headers);
        expect(csp).not.toMatch(/cloudflareinsights/);
        expect(cspTokens(csp, 'script-src')).not.toContain('https://static.cloudflareinsights.com');
        expect(cspTokens(csp, 'connect-src')).not.toContain('https://cloudflareinsights.com');
    });
});

describe('deploy/nginx-wander.conf static block', () => {
    const conf = readDeploy('nginx-wander.conf');

    test('/wander serves the wander webroot and includes the shared header snippet', () => {
        const block = blockFor(conf, '/wander');
        expect(block).not.toBe('');
        expect(block).toMatch(/alias\s+\/var\/www\/html\/wander;/);
        expect(block).toMatch(/include\s+\S*wander-headers\.conf;/);
        // nginx add_header is all-or-nothing per context: a block that grew its
        // own copy would silently shadow the shared set, and the weaker of the
        // two would win for whoever hit that block, with no error anywhere.
        expect(directivesOf(block)).not.toMatch(/add_header/);
    });

    test('the static block replaces the inherited beacon sub_filter (finding #12872)', () => {
        // nginx has no `sub_filter off`. A location-level sub_filter replaces
        // the server-level list, which is what injects beacon.min.js. /explorer/
        // rewrites into this location, so one directive covers both prefixes.
        // The substitution itself must not be the beacon.
        const block = directivesOf(blockFor(conf, '/wander'));
        expect(block).toMatch(/sub_filter\s+/);
        expect(block).not.toMatch(/cloudflareinsights/);
        expect(block).not.toMatch(/beacon\.min\.js/);
    });

    // Cloud-backup links are /<prefix>/<username>#t=<token>. Dropping try_files
    // serves a 404 instead of index.html, so the SPA never reads
    // location.pathname. The committed snippet is the reviewable source of
    // truth — live nginx is copied from it (finding #7582).
    test('/wander falls back to its own index', () => {
        expect(blockFor(conf, '/wander')).toMatch(/^\s*try_files\s+\$uri\s+\$uri\/\s+\/wander\/index\.html;/m);
    });

    test('blockFor tells the static block from its API sibling', () => {
        // Guards the helper itself: `location /wander` is a prefix of
        // `location /wander/api/`, and the old split-on-substring approach
        // matched the wrong one.
        expect(blockFor(conf, '/wander')).toMatch(/alias/);
        expect(blockFor(conf, '/wander')).not.toMatch(/proxy_pass/);
    });
});

describe('deploy/nginx-wander.conf legacy /explorer prefix', () => {
    const conf = readDeploy('nginx-wander.conf');

    test('everything under /explorer/ is re-matched as /wander/, internally', () => {
        // A REWRITE, not a redirect: the browser URL must stay put so the
        // #t=<token> fragment and the username in the path reach the SPA
        // exactly as sent, with no dependence on client redirect behaviour
        // for a credential.
        const block = blockFor(conf, '^~ /explorer/');
        expect(block).not.toBe('');
        expect(block).toMatch(/rewrite\s+\^\/explorer\/\(\.\*\)\$\s+\/wander\/\$1\s+last;/);
        expect(directivesOf(block)).not.toMatch(/return\s+30[12]/);
    });

    test('the legacy prefix is ^~, so the regex asset locations cannot outrank it', () => {
        // This is the whole bug the rewrite replaced. A regex location beats a
        // prefix location, so the vhost's `location ~* \.(css|js|…)$` blocks
        // won against a plain `location /explorer` — meaning /explorer/sync.js
        // was never served by the /explorer block at all, only ever from the
        // server-level root, and 404'd the moment the webroot was renamed.
        // Drop the ^~ and the legacy prefix serves an HTML shell with no
        // scripts: HTTP 200, blank app, nothing in any log.
        expect(conf).toMatch(/location\s+\^~\s+\/explorer\/\s*\{/);
    });

    test('bare /explorer redirects — it carries no username and no fragment', () => {
        expect(blockFor(conf, '= /explorer')).toMatch(/return\s+301\s+\/wander\/;/);
    });

    test('the legacy prefix owns no headers, no alias and no proxy of its own', () => {
        // Everything it needs it gets by being re-matched into the /wander
        // blocks. A second copy of the CSP or the proxy pins is exactly the
        // drift this structure exists to make impossible.
        const block = directivesOf(blockFor(conf, '^~ /explorer/'));
        expect(block).not.toMatch(/add_header|alias|proxy_pass|try_files/);
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

describe('deploy/nginx-wander.conf API proxy (finding #7582)', () => {
    const conf = readDeploy('nginx-wander.conf');

    // One proxy block, not two. /explorer/api/ is permanent, but it reaches
    // this same block through the legacy-prefix rewrite, so its rate limit and
    // XFF overwrite cannot drift away from the canonical prefix's.
    test('/wander/api/ is pinned to the wander-api upstream, rate-limited, and does not trust client XFF', () => {
        const block = blockFor(conf, '/wander/api/');
        expect(block).not.toBe('');
        expect(block).toMatch(/^\s*limit_req\s+zone=api\s+burst=10\s+nodelay;/m);
        // The root:www-data unix socket, never loopback TCP: wander-api trusts
        // X-Real-IP only on that socket (finding #10094).
        expect(block).toMatch(/^\s*proxy_pass\s+http:\/\/unix:\/run\/wander-api\.sock:\/api\/;/m);
        expect(directivesOf(block)).not.toMatch(/127\.0\.0\.1|localhost/);
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
    const imgSrc = cspTokens(csp, 'img-src');

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
                if (!imgSrc.includes(token)) missing.push(`${token} (${host})`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('the scan sees real tile layers, so it cannot pass vacuously', () => {
        expect(imgSrc.length).toBeGreaterThan(0);
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

    function hostsIn(file) {
        const src = readFileSync(resolve(ROOT, file), 'utf8');
        return [...new Set([...src.matchAll(/https:\/\/([a-zA-Z0-9._-]+)/g)].map((m) => m[1]))];
    }

    test('every fetched host is its own connect-src token', () => {
        const missing = [];
        for (const file of FETCHING_MODULES) {
            for (const host of hostsMissingFromConnect(csp, hostsIn(file))) {
                missing.push(`${host} (${file})`);
            }
        }
        expect(missing).toEqual([]);
        // mase.fi is skipped above because 'self' covers it. That skip is a
        // lie if the token is gone: osrm.js fetches this origin.
        expect(cspTokens(csp, 'connect-src')).toContain("'self'");
    });

    test('a longer host or a path-restricted token does not count (finding #12672)', () => {
        const bad = [
            'connect-src https://routing.openstreetmap.de.invalid',
            'https://api.open-meteo.com/wrong',
            'https://nominatim.openstreetmap.org.example',
        ].join(' ');
        expect(hostsMissingFromConnect(bad, [
            'routing.openstreetmap.de',
            'api.open-meteo.com',
            'nominatim.openstreetmap.org',
        ])).toEqual([
            'routing.openstreetmap.de',
            'api.open-meteo.com',
            'nominatim.openstreetmap.org',
        ]);
        // The old String.includes check matches every one of these.
        expect(bad.includes('https://routing.openstreetmap.de')).toBe(true);
        expect(bad.includes('https://api.open-meteo.com')).toBe(true);
    });

    test('the scan sees real hosts, so it cannot pass vacuously', () => {
        expect(cspTokens(csp, 'connect-src').length).toBeGreaterThan(0);
        expect(hostsIn('osrm.js')).toContain('routing.openstreetmap.de');
        // Anchored on elevation.js since overpass.js stopped naming a third
        // party (its pools are same-origin now). This assertion is why the
        // scan above cannot pass by scanning nothing, so it must always point
        // at a module that really does fetch a cross-origin host — re-anchor
        // it, never delete it.
        expect(hostsIn('elevation.js')).toContain('api.open-meteo.com');
    });
});

describe('CSP script-src and style-src cover every URL index.html loads (finding #12672)', () => {
    const csp = cspFrom(readDeploy('nginx-wander-headers.conf'));
    const { scripts, styles } = pageResources();

    test('every stylesheet is allowed by style-src and every script by script-src', () => {
        expect(urlsMissingFrom(csp, 'style-src', styles)).toEqual([]);
        expect(urlsMissingFrom(csp, 'script-src', scripts)).toEqual([]);
    });

    test('the scan sees the leaflet files and a same-origin script, so it cannot pass vacuously', () => {
        expect(scripts.some((s) => s.startsWith('https://unpkg.com/leaflet@'))).toBe(true);
        expect(styles.some((s) => s.startsWith('https://unpkg.com/leaflet@'))).toBe(true);
        expect(scripts.some((s) => !isAbsoluteHttp(s))).toBe(true);
        expect(styles.some((s) => !isAbsoluteHttp(s))).toBe(true);
    });

    test('a directory token allows the file; the same token on img-src does not', () => {
        const script = scripts.find((s) => s.startsWith('https://unpkg.com/leaflet@'));
        const style = styles.find((s) => s.startsWith('https://unpkg.com/leaflet@'));
        expect(script).toBeTruthy();
        expect(style).toBeTruthy();
        // Parent directory of the file, the way the live header allows the
        // version path rather than naming leaflet.js itself.
        const prefix = script.slice(0, script.lastIndexOf('/') + 1);
        const allowed = `script-src ${prefix}; style-src ${prefix}`;
        expect(urlsMissingFrom(allowed, 'script-src', [script])).toEqual([]);
        expect(urlsMissingFrom(allowed, 'style-src', [style])).toEqual([]);
        // A header-wide search still sees the token. script-src and style-src do not.
        const onlyImg = `script-src 'self'; style-src 'self'; img-src ${prefix}`;
        expect(onlyImg.includes(prefix)).toBe(true);
        expect(urlsMissingFrom(onlyImg, 'script-src', [script])).toEqual([script]);
        expect(urlsMissingFrom(onlyImg, 'style-src', [style])).toEqual([style]);
    });
});
