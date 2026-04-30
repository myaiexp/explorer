// Single-line structured stdout — captured by journald.

type Fields = Record<string, string | number | boolean | null | undefined>;

export function log(level: 'INFO' | 'WARN' | 'ERROR', fields: Fields): void {
    const ts = new Date().toISOString();
    const parts = [ts, level];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        const s = typeof v === 'string' ? v : String(v);
        parts.push(`${k}=${s.includes(' ') ? JSON.stringify(s) : s}`);
    }
    console.log(parts.join(' '));
}
