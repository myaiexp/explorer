// Iconography contract for inline SVGs in index.html — fleet stroke weight + grid.
// Spec: mase.fi docs/design-cards/iconography (viewBox 20|24, stroke 1.5, round caps).
// idea #2472: explorer icons drifted to mixed 16-grid / stroke-2 weights.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
    'utf8'
);

// Every <svg …> opening tag in the document (self-contained icons, not map markers).
const svgOpens = html.match(/<svg\b[^>]*>/g) ?? [];

describe('index.html inline SVG iconography contract', () => {
    test('page has at least one inline SVG icon', () => {
        expect(svgOpens.length).toBeGreaterThan(0);
    });

    test('every icon uses a square 20- or 24-grid viewBox (not 16)', () => {
        for (const tag of svgOpens) {
            const vb = tag.match(/viewBox="([^"]+)"/);
            expect(vb, `missing viewBox on ${tag}`).toBeTruthy();
            expect(
                vb[1] === '0 0 24 24' || vb[1] === '0 0 20 20',
                `viewBox must be 20- or 24-grid, got "${vb[1]}" on ${tag}`
            ).toBe(true);
        }
    });

    test('every stroked icon uses stroke-width 1.5 and round caps/joins', () => {
        for (const tag of svgOpens) {
            // Filled-only glyphs (none currently) would skip; all explorer icons stroke.
            expect(tag, tag).toMatch(/stroke-width="1\.5"/);
            expect(tag, tag).toMatch(/stroke-linecap="round"/);
            expect(tag, tag).toMatch(/stroke-linejoin="round"/);
            expect(tag, tag).toMatch(/stroke="currentColor"/);
            expect(tag, tag).not.toMatch(/stroke-width="2"/);
            expect(tag, tag).not.toMatch(/stroke-width="2\.5"/);
        }
    });
});
