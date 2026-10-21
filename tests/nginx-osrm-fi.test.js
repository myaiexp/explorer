// @vitest-environment node
// Pins the OSRM proxy comment against the wire. nginx does not add a wildcard
// ACAO (tests/nginx-security.test.js), but osrm-routed emits one and proxy_pass
// forwards it — a comment that says the wildcard was dropped is a false contract.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const conf = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../deploy/nginx-osrm-fi.conf'),
    'utf8',
);

describe('deploy/nginx-osrm-fi.conf comment', () => {
    test('says the upstream wildcard is forwarded, and does not claim it was dropped', () => {
        expect(conf).toMatch(/osrm-routed emits a wildcard cross-origin header/);
        expect(conf).toMatch(/proxy_pass forwards it/);
        expect(conf).not.toMatch(/dropping it/);
    });
});
