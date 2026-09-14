// Vitest config for the server suite — Node environment for Node built-ins (fileURLToPath, pg, etc.)
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        // All DB-backed files share the one wander_test DB and truncateAll() in
        // beforeEach, so files must run sequentially — parallel files race on truncate.
        fileParallelism: false,
        // …and every WORKTREE shares that same wander_test, because Helm copies
        // server/.env verbatim into each one. fileParallelism only serializes
        // files within one process, so a second session's suite truncated this
        // one's rows mid-test (idea #4042). global-setup.ts holds a Postgres
        // advisory lock on the resolved test database for the length of the run.
        globalSetup: './tests/global-setup.ts',
        // Enforced by `pnpm test:coverage`; plain `pnpm test` and path-filtered
        // runs skip it, since a filtered run would always miss the floor.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // ~1 point under the 2026-09-14 baseline (lines 98.2, functions 95.3,
            // branches 96.8); raise them as coverage grows.
            thresholds: { lines: 97, statements: 97, functions: 94, branches: 95 },
        },
    },
});
