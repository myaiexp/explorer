import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    },
});
