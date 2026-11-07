/**
 * Shared bootstrap for the repo-root browser scripts under test — one idiom for
 * evaluating them, and the one place that mirrors index.html's load order.
 *
 * The scripts under test are classic (non-module) <script> files: each assigns
 * its public names onto globalThis and reads its collaborators back off
 * globalThis at load or call time. A test therefore only needs them evaluated,
 * in dependency order, in the current realm.
 *
 * `vm.compileFunction(src).call(globalThis)` is that evaluation, and it is the
 * ONLY idiom here on purpose. This suite used to carry two — readFileSync +
 * vm.Script in the node-environment files, ?raw + new Function in the jsdom ones
 * — so a load-order fix applied to one style silently missed the other (audit
 * #5443). compileFunction has new Function's semantics — a function scope, so
 * re-evaluating a script with a top-level `const` does not throw; sloppy mode
 * unless the script opts in; `this` is globalThis — and works under both vitest
 * environments, since jsdom tests run in Node's own realm with the window
 * copied onto globalThis. What it adds over new Function is a filename with no
 * textual wrapper: V8 names the script after the real file and its offsets match
 * the file exactly, so v8 coverage and stack traces land on geometry.js:22
 * instead of an anonymous function (finding #10112). Don't go back to new
 * Function — its `(function anonymous(` prefix shifts every coverage offset.
 *
 * Sources arrive through the virtual module from ./root-scripts-plugin.js, not
 * Vite's ?raw glob: v8 coverage keys a module by its path with the query
 * stripped, so each `?raw` string module was reported as the script's own
 * coverage (100% for every root script, run or not). The plugin adds each script
 * as a watch file, so watch mode still re-runs a test when a script it loads is
 * edited — as with the old eager glob, every root edit re-runs every test that
 * imports this helper. The import is static, which keeps the API synchronous.
 *
 * Note: security-hook warning acknowledged — evaluating source is intentional.
 * The sources are static local repo files, not user input.
 */

import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
// 'screening' → { path: '/abs/…/screening.js', src: '…' }
import ROOT_SCRIPTS from 'virtual:wander-root-scripts';

// index.html's load order, as direct dependencies. Its own module so
// scripts/test-related.mjs can read it in plain Node, outside Vite.
import { SCRIPT_DEPS } from './script-deps.js';
export { SCRIPT_DEPS };

/** Raw source text of a repo-root script, by bare name ('osrm', not 'osrm.js'). */
export function readScript(name) {
    if (!Object.hasOwn(ROOT_SCRIPTS, name)) {
        throw new Error(`no repo-root script named '${name}.js' (bare name, no extension)`);
    }
    return ROOT_SCRIPTS[name].src;
}

/**
 * Evaluate one script's source in the current realm. `filename` names the V8
 * script, so pass it only when `src` is that file's exact text — anything else
 * maps coverage and stack traces onto the wrong lines. Suites go through
 * loadScripts and read what they need back off globalThis — never slice a
 * single function out of a source, since the slice cannot see a sibling
 * helper it later calls.
 */
export function evalScript(src, filename) {
    vm.compileFunction(src, [], filename ? { filename } : {}).call(globalThis);
}

/**
 * Load the named repo-root scripts plus their SCRIPT_DEPS, in dependency order.
 * Deduped within the call, but NOT across calls — repeat calls re-evaluate, which
 * is what the tests that reload a module per-test rely on.
 */
export function loadScripts(...names) {
    const seen = new Set();
    const order = [];
    const visit = (name, chain) => {
        if (seen.has(name)) return;
        if (chain.includes(name)) {
            throw new Error(`circular SCRIPT_DEPS: ${[...chain, name].join(' → ')}`);
        }
        for (const dep of SCRIPT_DEPS[name] || []) visit(dep, [...chain, name]);
        seen.add(name);
        order.push(name);
    };
    for (const name of names) visit(name, []);
    for (const name of order) {
        evalScript(readScript(name), pathToFileURL(ROOT_SCRIPTS[name].path).href);
    }
    return order;
}
