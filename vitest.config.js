// Vitest config for the static-frontend suite (jsdom) — `pnpm test` at the repo root.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { rootScripts } from './tests/helpers/root-scripts-plugin.js';

export default defineConfig({
    // Serves the repo-root scripts to tests/helpers/load.js as text without a
    // ?raw import, which v8 coverage would mistake for the scripts themselves.
    plugins: [rootScripts(fileURLToPath(new URL('.', import.meta.url)))],
    test: {
        environment: 'jsdom',
        globals: true,
        // Node's own Web Storage (default-on from Node 25) shadows jsdom's
        // localStorage and silently defeats the Storage.prototype spies the
        // quota tests rely on. This rebinds it; a no-op on a Node without it.
        setupFiles: ['tests/setup/jsdom-storage.js'],
        // Root sweep covers only the static-frontend tests; server/tests and
        // junctions-cache/tests have their own workspace configs.
        include: ['tests/**/*.test.js'],
        coverage: {
            provider: 'v8',
            // The deployed browser scripts only: server/ and junctions-cache/
            // hold their own floors, tools/ is dev-only, tests/ is not app code.
            include: ['*.js'],
            exclude: ['vitest.config.js'],
            // Enforced by `pnpm test:coverage` only — a path-filtered run would
            // always miss it. Set ~1 point under the 2026-09-14 baseline (lines
            // 94.2, functions 96.6, branches 94.7); raise them as coverage grows.
            thresholds: { lines: 93, statements: 93, functions: 95, branches: 93 },
        },
    },
});
