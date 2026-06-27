// Vitest config for the junctions-cache suite — Node environment for the
// node:fs/promises + os.tmpdir usage in cache/persistence tests (jsdom stubs
// these out). Mirrors server/vitest.config.ts; run via `pnpm test` here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
    },
});
