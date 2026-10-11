// Bounded spawn for deploy-drift tests — a stuck ssh must not pin the worker.
//
// ssh's ConnectTimeout covers the TCP handshake, not getaddrinfo. The drift
// scripts run that ssh inside a command substitution, and execFileSync's
// timeout SIGTERMs only its direct child — bash dies, the ssh grandchild is
// reparented, and the lookup keeps going. The direct child is therefore GNU
// timeout, which owns the process group and forwards the signal. Its own
// timer sits behind the caller's bound, so a refused host still fails inside
// ConnectTimeout and reports unreachable; only a stuck resolver hits this.
import { execFileSync } from 'node:child_process';

// Past ConnectTimeout=10 so a refused host still reports itself unreachable.
export const DRIFT_SUBPROCESS_TIMEOUT_MS = 15_000;

export function execDriftScript(script, env, timeoutMs = DRIFT_SUBPROCESS_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('drift subprocess timeout must be a positive number of milliseconds');
    }
    // Backstop only. Node's timeout is the one that fires; GNU timeout's own
    // timer is there so a signal that `timeout` itself ignores still ends the tree.
    const backstopSec = Math.ceil(timeoutMs / 1000) + 5;
    try {
        const stdout = execFileSync(
            'timeout',
            ['--signal=TERM', '--kill-after=2s', `${backstopSec}s`, 'bash', script],
            {
                env,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: timeoutMs,
            },
        );
        return { code: 0, out: stdout, signal: null };
    } catch (e) {
        return {
            code: e.status ?? null,
            out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
            signal: e.signal ?? null,
        };
    }
}
