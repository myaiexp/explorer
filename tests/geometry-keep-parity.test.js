// @vitest-environment node
/**
 * Drift guard for the newest-N geometry window that exists in two independent
 * deployables:
 *   - storage.js VISIT_GEOMETRY_KEEP          (quota-trim of local visits)
 *   - server/src/lib/validate-fields.ts
 *     GET_GEOMETRY_KEEP                       (GET /:username omits older polylines)
 *
 * Both sides carry reciprocal TWIN comments: the quota trim and the default GET
 * snapshot MUST keep the same newest-N window so the init-path merge and the
 * local trim agree on which walks still have drawable geometry. There is no
 * shared package to enforce this, so this test is the enforcement — the sibling
 * of tests/visit-shape-parity.test.js. Changing only one side stays green in
 * storage.test.js / account-data.test.ts because those pin behaviour against
 * their own constant, not the pair.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GET_GEOMETRY_KEEP } from '../server/src/lib/validate-fields.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function numberConst(src, name) {
    const m = src.match(new RegExp(`(?:const|export const) ${name} = (\\d+)`));
    if (!m) throw new Error(`${name} numeric literal not found — did the format change?`);
    return Number(m[1]);
}

const storageSrc = readFileSync(join(ROOT, 'storage.js'), 'utf8');
const fieldsSrc = readFileSync(join(ROOT, 'server/src/lib/validate-fields.ts'), 'utf8');

describe('geometry-keep window parity: storage.js ↔ GET /:username', () => {
    test('VISIT_GEOMETRY_KEEP and GET_GEOMETRY_KEEP are the same 50', () => {
        const client = numberConst(storageSrc, 'VISIT_GEOMETRY_KEEP');
        const serverLiteral = numberConst(fieldsSrc, 'GET_GEOMETRY_KEEP');
        expect(client).toBe(50);
        expect(serverLiteral).toBe(50);
        expect(client).toBe(serverLiteral);
        // Source extraction agrees with the TS module's runtime value, so a
        // comment-only edit on the server cannot silently desync the import.
        expect(serverLiteral).toBe(GET_GEOMETRY_KEEP);
    });
});
