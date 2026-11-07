// Resolve changed repo files to the root-suite test files that exercise them.
//
// `vitest related` walks static ESM imports, and the root scripts are evaluated
// from text by ./load.js, never imported — so it finds nothing for geometry.js
// and exits 0. This reads the edges the suite actually has, per file under
// tests/:
//   - loadScripts('x', …) names, expanded through SCRIPT_DEPS (loading osrm
//     runs geometry.js, so a geometry change reaches osrm's suite);
//   - readScript('x') names — text only, so no SCRIPT_DEPS expansion;
//   - any string literal naming an existing repo file or directory
//     ('storage.js', 'deploy/check-unit-drift.sh', resolve(ROOT, 'deploy'));
//   - a readdirSync(…) filtered on .js — a whole-tree guard, related to every
//     root script;
//   - relative imports, so a script loaded inside a helper (sync-harness.js)
//     reaches every suite importing that helper.
// Over-inclusion costs a few extra tests; a missed edge is a scoped run that
// passes without running the test that would fail, so the edges err wide.
// Pure Node: no Vite, so scripts/test-related.mjs can call it directly.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { SCRIPT_DEPS } from './script-deps.js';

// Directories with their own package.json and vitest suite.
const OWN_SUITES = ['server', 'junctions-cache', 'tools'];

const LOAD_CALL = /\b(loadScripts|readScript)\(([^)]*)\)/g;
const QUOTED_NAME = /['"]([a-z0-9-]+)['"]/g;
const STRING_LITERAL = /['"`]([\w@+-][\w./@+-]*)['"`]/g;
const IMPORT_SPEC = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"](\.\.?\/[^'"]+)['"]/g;
const WHOLE_TREE = /readdirSync\([^)]*\)[\s\S]{0,160}?endsWith\(\s*['"]\.js['"]\s*\)/;

const toPosix = (p) => p.split(sep).join('/');
const isTestFile = (rel) => /^tests\/.+\.test\.js$/.test(rel);

function walk(dir, root, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, root, out);
        else if (/\.(m?js)$/.test(e.name)) out.push(toPosix(relative(root, p)));
    }
    return out;
}


// Repo-relative paths a literal names: the file itself, or every file under a
// named directory. The repo root and tests/ are never literal targets — tests
// reach each other through imports, not strings.
// Memoized per literal: the suite repeats the same strings in every file.
function literalTargets(root, literal, cache) {
    if (cache.has(literal)) return cache.get(literal);
    const abs = resolve(root, literal);
    const rel = toPosix(relative(root, abs));
    let out = [];
    const excluded = !rel || rel.startsWith('..') || rel === 'tests' || rel.startsWith('tests/')
        || rel.split('/').includes('node_modules');
    // throwIfNoEntry: most literals name nothing, and a throwing stat per
    // literal was most of the scan's run time.
    const st = excluded ? undefined : statSync(abs, { throwIfNoEntry: false });
    if (st?.isFile()) out = [rel];
    else if (st?.isDirectory()) out = walkAll(abs, root);
    cache.set(literal, out);
    return out;
}

function walkAll(dir, root, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walkAll(p, root, out);
        else out.push(toPosix(relative(root, p)));
    }
    return out;
}

// Comments name scripts in prose ('geometry.js', `osrm.js`), and a helper's
// prose would otherwise reach every suite importing it. Block comments, and
// line comments that start a line — a `//` mid-line may sit inside a URL.
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function scanFile(root, rel, literalCache) {
    const src = stripComments(readFileSync(join(root, rel), 'utf8'));
    // loads run their SCRIPT_DEPS too; refs are read as text and stop there.
    const loads = new Set();
    const refs = new Set();
    for (const [, fn, args] of src.matchAll(LOAD_CALL)) {
        for (const [, name] of args.matchAll(QUOTED_NAME)) (fn === 'loadScripts' ? loads : refs).add(`${name}.js`);
    }
    for (const [, literal] of src.matchAll(STRING_LITERAL)) {
        for (const target of literalTargets(root, literal, literalCache)) refs.add(target);
    }
    const imports = [];
    for (const [, spec] of src.matchAll(IMPORT_SPEC)) {
        imports.push(toPosix(relative(root, resolve(root, dirname(rel), spec))));
    }
    return { loads, refs, imports, wholeTree: WHOLE_TREE.test(src) };
}

// Forward closure of a root script over SCRIPT_DEPS: everything loadScripts
// evaluates when a test names it.
function withDeps(file) {
    const out = new Set([file]);
    const stack = [file];
    while (stack.length) {
        const name = stack.pop().replace(/\.js$/, '');
        for (const dep of SCRIPT_DEPS[name] ?? []) {
            const f = `${dep}.js`;
            if (!out.has(f)) { out.add(f); stack.push(f); }
        }
    }
    return out;
}

/** Per test file: every repo file it reaches, and whether it reads the whole root tree. */
function buildGraph(root, onlyTests) {
    const literalCache = new Map();
    const scanned = new Map();
    for (const rel of walk(join(root, 'tests'), root)) scanned.set(rel, scanFile(root, rel, literalCache));

    const memo = new Map();
    const reach = (rel, chain = new Set()) => {
        if (memo.has(rel)) return memo.get(rel);
        const node = scanned.get(rel);
        const acc = { refs: new Set(), files: new Set([rel]), wholeTree: false };
        if (!node || chain.has(rel)) return acc;
        chain.add(rel);
        for (const load of node.loads) for (const f of withDeps(load)) acc.refs.add(f);
        node.refs.forEach((f) => acc.refs.add(f));
        acc.wholeTree = node.wholeTree;
        for (const imp of node.imports) {
            const sub = reach(imp, chain);
            sub.refs.forEach((f) => acc.refs.add(f));
            sub.files.forEach((f) => acc.files.add(f));
            acc.wholeTree ||= sub.wholeTree;
        }
        chain.delete(rel);
        memo.set(rel, acc);
        return acc;
    };

    const tests = onlyTests ?? [...scanned.keys()].filter(isTestFile);
    return tests.map((rel) => ({ rel, ...reach(rel) }));
}

/**
 * @param {string} root repo root
 * @param {string[]} targets changed files — repo-relative, ./-relative or absolute
 * @param {{tests?: string[]}} [opts] restrict the candidate test files (tests only)
 * @returns {{files: string[], errors: string[]}} sorted test files, and one
 *   error per target that resolves to none — the caller must fail on any
 */
export function resolveRelated(root, targets, opts = {}) {
    const graph = buildGraph(root, opts.tests);
    const files = new Set();
    const errors = [];

    for (const target of targets) {
        const abs = resolve(root, target);
        const rel = toPosix(relative(root, abs));
        if (!rel || rel.startsWith('..')) {
            errors.push(`${target}: outside the repo`);
            continue;
        }
        if (!existsSync(abs)) {
            errors.push(`${target}: no such file`);
            continue;
        }
        const pkg = OWN_SUITES.find((d) => rel === d || rel.startsWith(`${d}/`));
        if (pkg) {
            errors.push(`${target}: ${pkg}/ has its own suite — run it there (cd ${pkg} && pnpm test)`);
            continue;
        }

        let hits;
        if (isTestFile(rel)) {
            hits = [rel];
        } else if (rel.startsWith('tests/')) {
            hits = graph.filter((t) => t.files.has(rel)).map((t) => t.rel);
        } else {
            const rootScript = !rel.includes('/') && rel.endsWith('.js');
            hits = graph.filter((t) => t.refs.has(rel) || (rootScript && t.wholeTree)).map((t) => t.rel);
        }
        if (hits.length === 0) {
            errors.push(`${target}: no test file loads, reads or imports it — a scoped run would test nothing`);
            continue;
        }
        hits.forEach((f) => files.add(f));
    }
    return { files: [...files].sort(), errors };
}
