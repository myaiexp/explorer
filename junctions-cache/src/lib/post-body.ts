// Shared POST-body reading and the query-string anchor guard for every route.

import type { Context } from 'hono';
import { BodyTooLargeError, readTextCapped } from './read-capped.js';

// Match nginx client_max_body_size 16k so a direct tailnet POST cannot
// dump an unbounded JSON body that the proxy would have refused.
export const MAX_POST_BYTES = 16 * 1024;

export type BodyResult =
    | { ok: true; body: unknown }
    | { ok: false; status: 400 | 413; error: string };

// Read and parse a capped JSON request body. Shared by /junctions and the pool
// endpoints so the cap, the 413-vs-400 split and the parse all stay one
// implementation — a fix to any of them cannot land on one route only.
export async function readJsonBody(c: Context): Promise<BodyResult> {
    try {
        const text = await readTextCapped(
            c.req.raw.body,
            MAX_POST_BYTES,
            'request',
            c.req.header('content-length'),
        );
        return { ok: true, body: JSON.parse(text) };
    } catch (e) {
        if (e instanceof BodyTooLargeError) return { ok: false, status: 413, error: 'body too large' };
        return { ok: false, status: 400, error: 'invalid JSON' };
    }
}

// startLat/startLng on the request line land in nginx access logs at full JS
// precision (often home). GET is bbox-only; anchored lookups go through POST
// (finding #7559). A leftover query-string start on POST is refused the same way.
export const QUERY_ANCHOR_ERROR = 'startLat, startLng, maxKm must be sent in the POST body';

export function queryHasAnchor(c: Context): boolean {
    return c.req.query('startLat') != null
        || c.req.query('startLng') != null
        || c.req.query('maxKm') != null;
}
