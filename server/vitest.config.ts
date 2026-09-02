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
    },
});
