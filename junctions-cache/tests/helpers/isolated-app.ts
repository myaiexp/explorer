// Isolated junctions-cache test bootstrap — temp cache dir, module reset, app fetch.
// The HTTP suites and cache.test.ts each owned a copy of this, and the copies
// had forked (finding #12678): only server.test.ts deleted LOGS_TOKEN, and
// post() had two signatures. vi.mock stays in the suite file — the overpass
// mock shape differs — and loadServer's pick callback re-imports whichever
// mocked modules that file wants back after the reset.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

const tmpDirs: string[] = [];

// Every env var these suites write. CACHE_PATH is read once, at cache-store
// import, so a leaked value points the next file at a directory this cleanup
// already deleted. LOGS_TOKEN left set reopens GET /logs for whatever file
// runs next. The tuning vars are the same shape: read once at import.
const ISOLATED_ENV = [
    'LOGS_TOKEN',
    'CACHE_PATH',
    'CACHE_TTL_MS',
    'CACHE_EMPTY_TTL_MS',
    'CACHE_MAX_ENTRIES',
    'CACHE_MAX_POINTS',
    'CACHE_SAVE_DEBOUNCE_MS',
] as const;

export function tmpDir(prefix = 'jcache-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

// Never created here — loadCache treats ENOENT as an empty store.
export function tmpCacheFile(prefix = 'jcache-'): string {
    return join(tmpDir(prefix), 'cache.json');
}

export function cleanupIsolatedState(): void {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const key of ISOLATED_ENV) delete process.env[key];
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// fakeTimers is for the HTTP suites, whose debounced cache save must not touch
// the disk. cache.test.ts leaves it off: its persistence tests drive the real
// 200ms debounce, and a beforeEach that installed fake timers would change
// every test that never opted in.
export function installIsolatedLifecycle(options?: { fakeTimers?: boolean }): void {
    if (options?.fakeTimers) {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.clearAllMocks();
        });
    }
    afterEach(() => {
        cleanupIsolatedState();
    });
}

// cache.ts (and cache-store.ts under it) keeps its store on the module and
// reads CACHE_PATH once at import. resetModules is what makes the next import
// a new store; the caller imports after that, so the env is already set.
export async function resetCacheModules<T>(cachePath: string, load: () => Promise<T>): Promise<T> {
    vi.resetModules();
    process.env.CACHE_PATH = cachePath;
    return load();
}

export type AppFetch = (req: Request) => Promise<Response>;

export async function loadServer<T extends object>(
    pick: () => Promise<T>,
    prefix = 'japp-',
): Promise<T & { fetch: AppFetch }> {
    return resetCacheModules(tmpCacheFile(prefix), async () => {
        const extra = await pick();
        const { createApp } = await import('../../src/app.js');
        const app = createApp();
        return { ...extra, fetch: app.fetch as AppFetch };
    });
}

export type PostOptions = {
    raw?: string;
    headers?: Record<string, string>;
};

// One POST shape for every route suite. Path is positional — a default of
// /junctions made the old post-junctions helper accept a pools call that
// forgot its path. raw replaces the body; headers ride on top of content-type.
export async function post(
    fetch: AppFetch,
    path: string,
    body: unknown,
    { raw, headers }: PostOptions = {},
): Promise<{ status: number; body: any }> {
    const res = await fetch(new Request('http://localhost' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw ?? JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
}
