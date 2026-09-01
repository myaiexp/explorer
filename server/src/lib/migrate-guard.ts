// May this `pnpm db:migrate` run? Pure — no I/O, no DB, no git, no clock.
//
// server/.env points DATABASE_URL at the production `explorer` database, and Helm copies
// that file verbatim into every worktree. So `drizzle-kit migrate` from a worktree
// rewrites PROD's schema while prod still runs whatever is on master — a DROP applied
// here breaks the deployed code and stays broken until that branch deploys. helm lived
// this on 2026-08-22: four columns gone from a worktree, 25 minutes of HTTP 500.
//
// The fix is not a new pipeline: forgejo-deploy ALREADY runs `pnpm drizzle-kit migrate`
// in ~/Projects/explorer/server the moment a push lands, straight after the build. So
// the destructive half simply belongs there, and this guard's whole job is to send it
// there. Additive DDL still applies straight from a worktree, because that is what a
// session developing against a new column needs. Note forgejo-deploy calls the drizzle
// binary, not this script — the deploy path cannot be wedged by the guard.
//
// Ported from helm's src/db/migrate-guard.ts (idea #3965).
import type { DestructiveStatement } from './destructive-ddl.js';

/** A migration drizzle-kit is about to apply, with whatever the scan found in it. */
export interface PendingMigration {
  /** Journal tag, e.g. '0002_cool_union_jack'. */
  tag: string;
  findings: DestructiveStatement[];
}

export interface MigrateGuardInput {
  /**
   * Is the CWD the repo's MAIN checkout (~/Projects/explorer, the tree forgejo-deploy
   * checks out and migrates)?
   *
   * `null` means git could not answer, which counts as "not the main checkout": the
   * escape is one flag, while guessing the other way reproduces the incident.
   */
  mainCheckout: boolean | null;
  pending: PendingMigration[];
  /** `--force` — the operator asserts prod's running code no longer needs the surface. */
  force: boolean;
}

export type MigrateGuardVerdict =
  | { action: 'run' }
  | { action: 'refuse'; offenders: PendingMigration[] };

/**
 * Refuse only when all three hold: destructive DDL, pending (so drizzle really would
 * apply it), and a tree that is not the one prod runs. Anything else runs.
 */
export function decideMigrate({
  mainCheckout,
  pending,
  force,
}: MigrateGuardInput): MigrateGuardVerdict {
  if (force || mainCheckout === true) return { action: 'run' };
  const offenders = pending.filter((m) => m.findings.length > 0);
  return offenders.length > 0 ? { action: 'refuse', offenders } : { action: 'run' };
}

/**
 * The refusal text. It names every offending statement, because the first question is
 * always "which line?" — and then the resolution, which is usually to do nothing at all
 * and let the deploy apply it.
 */
export function renderRefusal(
  offenders: PendingMigration[],
  opts: { mainCheckout: boolean | null },
): string {
  const lines: string[] = [];
  const where =
    opts.mainCheckout === null
      ? 'git could not say whether this is the main checkout'
      : 'this is a worktree, not the main checkout';

  lines.push('');
  lines.push(`✖  pnpm db:migrate refused: pending migrations contain destructive DDL and ${where}.`);
  lines.push('');
  lines.push("   server/.env aims DATABASE_URL at the PRODUCTION explorer database, and Helm copies");
  lines.push('   it into every worktree — so migrating from here rewrites prod\'s schema while prod');
  lines.push('   still runs the code on master. The dropped surface goes out from under it and stays');
  lines.push('   that way until this branch deploys.');
  lines.push('');

  for (const m of offenders) {
    lines.push(`   drizzle/${m.tag}.sql`);
    for (const f of m.findings) {
      lines.push(`     L${String(f.line).padEnd(4)} ${f.kind.padEnd(18)} ${f.statement}`);
    }
    lines.push('');
  }

  lines.push('   What to do:');
  lines.push('     • Nothing. Commit the .sql alongside the code and run `deploy` — forgejo-deploy');
  lines.push('       runs drizzle-kit migrate in ~/Projects/explorer/server right after the push');
  lines.push('       lands, so the drop ships with the code that stopped using the surface.');
  lines.push('     • Need the new schema to develop against? `pnpm db:reset:test` rebuilds');
  lines.push('       explorer_test from the migration chain — prod is not involved at all.');
  lines.push('     • Split expand from contract: the additive migration applies from a worktree');
  lines.push('       today, the destructive one ships with the code.');
  lines.push('     • Already deployed, or catching up a migration the deploy failed to apply?');
  lines.push('       pnpm db:migrate --force');
  lines.push('');

  return lines.join('\n');
}
