// Ported from helm's src/db/migrate-guard.test.ts (idea #3965). The refusal
// copy differs — wander migrates from forgejo-deploy, not from `deploy` — so
// the renderRefusal cases assert wander's own resolution path.
import { describe, it, expect } from 'vitest';
import { decideMigrate, renderRefusal, type PendingMigration } from './migrate-guard.js';

const destructive = (tag: string): PendingMigration => ({
  tag,
  findings: [{ line: 21, kind: 'DROP COLUMN', statement: 'ALTER TABLE visits DROP COLUMN c' }],
});
const additive = (tag: string): PendingMigration => ({ tag, findings: [] });

describe('decideMigrate', () => {
  it('refuses destructive pending DDL from a worktree', () => {
    const v = decideMigrate({ mainCheckout: false, pending: [destructive('0004_x')], force: false });
    expect(v).toEqual({ action: 'refuse', offenders: [destructive('0004_x')] });
  });

  it('allows destructive DDL from the main checkout — that IS the tree prod runs', () => {
    expect(decideMigrate({ mainCheckout: true, pending: [destructive('0004_x')], force: false })).toEqual({
      action: 'run',
    });
  });

  it('allows additive migrations from a worktree, which is the common case', () => {
    expect(decideMigrate({ mainCheckout: false, pending: [additive('0005_x')], force: false })).toEqual({
      action: 'run',
    });
  });

  it('treats an unanswerable git as not-the-main-checkout', () => {
    expect(decideMigrate({ mainCheckout: null, pending: [destructive('0004_x')], force: false }).action).toBe(
      'refuse',
    );
  });

  it('honours --force', () => {
    expect(decideMigrate({ mainCheckout: false, pending: [destructive('0004_x')], force: true })).toEqual({
      action: 'run',
    });
  });

  it('ignores an already-applied destructive migration — only pending ones can bite', () => {
    // The caller filters by drizzle's own gate. 0002 drops four indexes and stays on
    // disk forever; nothing pending means nothing to refuse.
    expect(decideMigrate({ mainCheckout: false, pending: [], force: false })).toEqual({ action: 'run' });
  });

  it('reports only the offending members of a mixed pending set', () => {
    const v = decideMigrate({
      mainCheckout: false,
      pending: [additive('0005_x'), destructive('0006_y')],
      force: false,
    });
    expect(v).toEqual({ action: 'refuse', offenders: [destructive('0006_y')] });
  });
});

describe('renderRefusal', () => {
  it('names the file, line, kind and statement of every finding', () => {
    const text = renderRefusal([destructive('0004_x')], { mainCheckout: false });
    expect(text).toContain('drizzle/0004_x.sql');
    expect(text).toContain('L21');
    expect(text).toContain('DROP COLUMN');
    expect(text).toContain('ALTER TABLE visits DROP COLUMN c');
  });

  it('points at deploy as the resolution and names the override', () => {
    const text = renderRefusal([destructive('0004_x')], { mainCheckout: false });
    expect(text).toContain('deploy');
    expect(text).toContain('pnpm db:migrate --force');
  });

  it('says so when git could not answer, rather than claiming a worktree', () => {
    expect(renderRefusal([destructive('0004_x')], { mainCheckout: null })).toContain('git could not say');
    expect(renderRefusal([destructive('0004_x')], { mainCheckout: false })).toContain('this is a worktree');
  });

  it('names db:reset:test as the way to get the schema locally', () => {
    // wander, unlike helm, HAS a dev database: wander_test. A session that only
    // needs to develop against the new shape never has to touch prod at all, and a
    // refusal that did not say so would push people straight to --force.
    expect(renderRefusal([destructive('0004_x')], { mainCheckout: false })).toContain('db:reset:test');
  });
});
