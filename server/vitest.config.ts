// Vitest config for the server suite — Node environment for Node built-ins (fileURLToPath, pg, etc.)
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        // All DB-backed files share the one explorer_test DB and truncateAll() in
        // beforeEach, so files must run sequentially — parallel files race on truncate.
        fileParallelism: false,
    },
});
