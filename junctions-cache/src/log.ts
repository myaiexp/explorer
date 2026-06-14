// Single-line structured stdout — captured by journald — plus a ring
// buffer so a debug endpoint can serve recent events back to a remote
// caller (i.e. me reading via mase.fi/api/junctions/logs).

type Fields = Record<string, string | number | boolean | null | undefined>;
type Entry = { ts: string; level: string; fields: Record<string, string | number | boolean> };

const RING_SIZE = 500;
const ring: Entry[] = [];

export function log(level: 'INFO' | 'WARN' | 'ERROR', fields: Fields): void {
    const ts = new Date().toISOString();
    const cleaned: Entry['fields'] = {};
    const parts = [ts, level];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        cleaned[k] = v;
        const s = typeof v === 'string' ? v : String(v);
        parts.push(`${k}=${s.includes(' ') ? JSON.stringify(s) : s}`);
    }
    console.log(parts.join(' '));

    ring.push({ ts, level, fields: cleaned });
    if (ring.length > RING_SIZE) ring.shift();
}

export function getRecentLogs(n: number): Entry[] {
    // Clamp to [0, RING_SIZE]; 0 (and negatives) mean "no logs". Special-case 0
    // because slice(-0) === slice(0) would return the whole ring, not [].
    const clamped = Math.max(0, Math.min(n, RING_SIZE));
    if (clamped === 0) return [];
    return ring.slice(-clamped);
}
