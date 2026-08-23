// Read a Request/Response body with a hard byte cap.

export class BodyTooLargeError extends Error {
    readonly bytes: number;
    readonly maxBytes: number;
    constructor(kind: string, bytes: number, maxBytes: number) {
        super(`${kind} body too large`);
        this.name = 'BodyTooLargeError';
        this.bytes = bytes;
        this.maxBytes = maxBytes;
    }
}

function declaredLength(header: string | null | undefined): number | null {
    if (header == null || header === '') return null;
    const n = Number(header);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

export async function readTextCapped(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
    kind: string,
    contentLength?: string | null,
): Promise<string> {
    const declared = declaredLength(contentLength);
    if (declared != null && declared > maxBytes) {
        if (body) await body.cancel().catch(() => {});
        throw new BodyTooLargeError(kind, declared, maxBytes);
    }
    if (body == null) return '';

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new BodyTooLargeError(kind, total, maxBytes);
            }
            chunks.push(value);
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already cancelled */ }
    }

    if (chunks.length === 0) return '';
    if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
}
