// @vitest-environment node
/**
 * Guard: pnpm settings must live where every pnpm version still reads them, and each
 * sub-project must stay its own pnpm root.
 *
 * pnpm 11 no longer reads the `pnpm` field in package.json. Verified on pnpm 11.22.0
 * (current `latest`; 12 is in RC): it prints `[WARN] The "pnpm" field in package.json is
 * no longer read by pnpm. The following keys were ignored: "pnpm.overrides"` and carries
 * on, resolving without the pins. Both overrides this repo carries are security pins —
 * brace-expansion CVE-2026-45149 at the root, esbuild GHSA-67mh-4wv8-2f99 in server/ —
 * so losing them silently reintroduces two known advisories. pnpm-workspace.yaml is read
 * by 10 and 11 alike, which is why the settings live there. Idea #3194.
 *
 * The second half is the trap that comes WITH that move. This repo is four independent
 * pnpm projects, not a workspace (four package.json files, four lockfiles; only
 * server/ and junctions-cache/ are `pnpm install`ed by deploy). pnpm resolves its
 * root by walking UP for the nearest pnpm-workspace.yaml, so once the repo root
 * has one, a sub-project without its own gets swallowed: `cd server && pnpm install`
 * then installs the ROOT project's deps and skips server entirely — no error, no
 * server lockfile, no server node_modules.
 * Verified on both 10.33.0 and 11.22.0. Hence: a package.json without a sibling
 * pnpm-workspace.yaml is a bug, and this test fails on it.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Every directory in the repo holding a package.json — i.e. every pnpm project. */
function findProjectDirs(dir = REPO_ROOT, found = []) {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) found.push(dir);
    for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        findProjectDirs(join(dir, entry.name), found);
    }
    return found;
}

/**
 * Minimal reader for the two shapes these files use: top-level `key:` and the indented
 * entries under `overrides:`. Deliberately not a YAML parser — the alternative is adding
 * a js-yaml devDep to a repo whose root deps are otherwise test-only.
 */
function readWorkspace(dir) {
    const text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    const lines = text.split('\n').filter((line) => !/^\s*#/.test(line));
    const overrides = {};
    let inOverrides = false;
    for (const line of lines) {
        if (/^overrides:\s*$/.test(line)) { inOverrides = true; continue; }
        if (/^\S/.test(line)) { inOverrides = false; continue; }
        if (!inOverrides) continue;
        const match = line.match(/^\s+'?([^':]+)'?:\s*(.+?)\s*$/);
        if (match) overrides[match[1]] = match[2];
    }
    const packages = lines.find((line) => /^packages:/.test(line)) ?? null;
    return { text, overrides, packages };
}

const projectDirs = findProjectDirs();

describe('pnpm settings location', () => {
    test('finds every pnpm project in the repo', () => {
        // Sanity check on the walk itself: if this drops to one, the assertions below
        // stop guarding the sub-projects and would pass vacuously.
        expect(projectDirs.map((d) => relative(REPO_ROOT, d) || '.').sort()).toEqual([
            '.',
            'junctions-cache',
            'server',
            'tools',
        ]);
    });

    test.each(projectDirs.map((d) => [relative(REPO_ROOT, d) || '<root>', d]))(
        '%s: package.json carries no `pnpm` field — pnpm 11 ignores it',
        (_label, dir) => {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            expect(pkg.pnpm).toBeUndefined();
        },
    );

    test.each(projectDirs.map((d) => [relative(REPO_ROOT, d) || '<root>', d]))(
        '%s: has its own pnpm-workspace.yaml, so pnpm stops here',
        (_label, dir) => {
            // Missing file => this project is silently absorbed into the root install.
            expect(() => readWorkspace(dir)).not.toThrow();
        },
    );

    test('the root does not claim the sub-projects as workspace members', () => {
        // `packages: []` keeps the four lockfiles separate, which is what the deploy
        // chain installs against (forgejo-deploy runs `pnpm install --frozen-lockfile`
        // in server/, the shelly post-receive hook does the same in junctions-cache/).
        // Converting this repo to a real workspace is a deliberate, deploy-affecting
        // change — it should trip this test rather than slip in.
        expect(readWorkspace(REPO_ROOT).packages).toBe('packages: []');
    });

    test('the root keeps the brace-expansion security pin', () => {
        // CVE-2026-45149 (moderate DoS), scoped to 5.x so the unaffected 2.x stays put.
        expect(readWorkspace(REPO_ROOT).overrides['brace-expansion@5']).toBe('^5.0.6');
    });

    test('server keeps the nested-esbuild security pin', () => {
        // GHSA-67mh-4wv8-2f99: drizzle-kit's @esbuild-kit chain still pulls esbuild
        // 0.18.20, which is below the patched 0.25.
        const overrides = readWorkspace(join(REPO_ROOT, 'server')).overrides;
        expect(overrides['@esbuild-kit/core-utils>esbuild']).toBe('0.25.12');
    });

    test.each(['server', 'junctions-cache'])(
        '%s pins hono at the CORS ReDoS floor (CVE-2026-69207 / finding #7896)',
        (dir) => {
            const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8'));
            const spec = pkg.dependencies.hono;
            expect(spec).toEqual(expect.stringMatching(/\d+\.\d+\.\d+/));
            const [maj, min, pat] = spec.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
            const atFloor = maj > 4 || (maj === 4 && min > 12) || (maj === 4 && min === 12 && pat >= 34);
            expect(atFloor, `${dir} hono spec ${spec} is below 4.12.34`).toBe(true);
        },
    );
});
