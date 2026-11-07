#!/usr/bin/env node
// `pnpm test:related <file…>` — run the root-suite tests that exercise those files.
//
// Use this instead of `vitest related` for repo-root scripts: vitest only sees
// static imports, finds no test for geometry.js and exits 0. The edges come from
// tests/helpers/related-tests.js. A file that maps to no test is an error, so a
// scoped run can never pass by running nothing.
//
//   pnpm test:related geometry.js osrm.js          run every related suite
//   pnpm test:related --list geometry.js           print them, run nothing
//   pnpm test:related geometry.js -- --reporter=dot   args after -- go to vitest

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveRelated } from '../tests/helpers/related-tests.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const own = dashDash === -1 ? argv : argv.slice(0, dashDash);
const passThrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);
const list = own.includes('--list');
// Relative to where the user ran it, which pnpm keeps as INIT_CWD.
const cwd = process.env.INIT_CWD ?? process.cwd();
const targets = own.filter((a) => a !== '--list').map((a) => resolve(cwd, a));

if (targets.length === 0) {
    console.error('usage: pnpm test:related [--list] <file…> [-- <vitest args>]');
    process.exit(2);
}

const { files, errors } = resolveRelated(ROOT, targets);
for (const e of errors) console.error(`test:related: ${e}`);
if (errors.length) process.exit(1);

if (list) {
    console.log(files.join('\n'));
    process.exit(0);
}

const vitest = resolve(ROOT, 'node_modules/.bin/vitest');
const run = spawnSync(vitest, ['run', ...files, ...passThrough], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
