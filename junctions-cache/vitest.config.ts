// Vitest config for the junctions-cache suite — Node environment for the
// node:fs/promises + os.tmpdir usage in cache/persistence tests (jsdom stubs
// these out). Mirrors server/vitest.config.ts; run via `pnpm test` here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        // Enforced by `pnpm test:coverage`; plain `pnpm test` and path-filtered
        // runs skip it, since a filtered run would always miss the floor.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // ~1 point under the 2026-09-14 baseline (lines 97.1, functions 100,
            // branches 95.4); raise them as coverage grows.
            thresholds: { lines: 96, statements: 96, functions: 99, branches: 94 },
        },
    },
});
