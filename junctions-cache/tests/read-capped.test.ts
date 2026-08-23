// @vitest-environment node
// Tests for junctions-cache/src/lib/read-capped.ts — stream a Request/Response
// body with a hard byte cap so JSON.parse never sees an unbounded buffer.

import { describe, test, expect } from 'vitest';
import { BodyTooLargeError, readTextCapped } from '../src/lib/read-capped.js';

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new Blob([text]).stream();
}

describe('readTextCapped', () => {
    test('returns the decoded body when it is under the cap', async () => {
        const text = await readTextCapped(streamOf('{"ok":true}'), 100, 'overpass');
        expect(text).toBe('{"ok":true}');
    });

    test('empty/missing body is the empty string', async () => {
        expect(await readTextCapped(null, 100, 'overpass')).toBe('');
        expect(await readTextCapped(streamOf(''), 100, 'overpass')).toBe('');
    });

    test('Content-Length over the cap fails before reading', async () => {
        const body = streamOf('{"tiny":true}');
        await expect(readTextCapped(body, 10, 'overpass', '999'))
            .rejects.toBeInstanceOf(BodyTooLargeError);
    });

    test('a body that streams past the cap is refused even without Content-Length', async () => {
        const body = streamOf('x'.repeat(50));
        await expect(readTextCapped(body, 16, 'overpass'))
            .rejects.toBeInstanceOf(BodyTooLargeError);
    });

    test('error names the kind so Overpass vs request caps are distinguishable', async () => {
        await expect(readTextCapped(streamOf('abcdef'), 3, 'request'))
            .rejects.toThrow(/request body too large/);
    });
});
