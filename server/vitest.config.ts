// Vitest config for the server suite — Node environment for Node built-ins (fileURLToPath, pg, etc.)
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
    },
});
