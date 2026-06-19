import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        // Root sweep covers only the static-frontend tests; server/tests and
        // junctions-cache/tests have their own workspace configs.
        include: ['tests/**/*.test.js'],
    },
});
