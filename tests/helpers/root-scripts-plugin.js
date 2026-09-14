// Vite plugin serving the repo-root browser scripts to tests as one module.
//
// tests/helpers/load.js evaluates these classic scripts itself, so it needs
// their text, not an ESM import. It used to get the text from
// import.meta.glob('../../*.js', { query: '?raw' }), and that blinded coverage:
// v8 attributes a module's coverage to its path with the query stripped, so the
// one-statement `export default "…"` string module was reported as the script's
// own coverage — every root script read 100% whether a test ran it or not.
//
// A virtual module has no file path, so nothing collides with the real files.
// load.js then evaluates each source under its own file:// name and v8 reports
// the actual script. addWatchFile keeps watch mode re-running on script edits.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT_SCRIPTS_ID = 'virtual:wander-root-scripts';
const RESOLVED_ID = `\0${ROOT_SCRIPTS_ID}`;

/** @param {string} root absolute path of the directory holding the scripts */
export function rootScripts(root) {
    return {
        name: 'wander-root-scripts',
        resolveId(id) {
            return id === ROOT_SCRIPTS_ID ? RESOLVED_ID : undefined;
        },
        load(id) {
            if (id !== RESOLVED_ID) return undefined;
            // 'screening.js' → { screening: { path, src } }
            const scripts = {};
            for (const file of readdirSync(root).sort()) {
                if (!file.endsWith('.js')) continue;
                const path = join(root, file);
                this.addWatchFile(path);
                scripts[file.slice(0, -'.js'.length)] = { path, src: readFileSync(path, 'utf8') };
            }
            return `export default ${JSON.stringify(scripts)};`;
        },
    };
}
