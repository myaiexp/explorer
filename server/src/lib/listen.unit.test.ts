// Unit tests for the systemd socket-activation listener checks (finding #10094).
import { describe, it, expect } from 'vitest';
import { inheritedSocketFd, isUnixListener } from './listen.js';

describe('inheritedSocketFd', () => {
  it('returns fd 3 when systemd passed one socket to this pid', () => {
    expect(inheritedSocketFd({ LISTEN_FDS: '1', LISTEN_PID: '4242' }, 4242)).toBe(3);
  });

  it('returns undefined without LISTEN_FDS (dev / tests bind loopback TCP)', () => {
    expect(inheritedSocketFd({}, 4242)).toBeUndefined();
  });

  it('ignores LISTEN_FDS meant for another process', () => {
    expect(inheritedSocketFd({ LISTEN_FDS: '1', LISTEN_PID: '1' }, 4242)).toBeUndefined();
    expect(inheritedSocketFd({ LISTEN_FDS: '1' }, 4242)).toBeUndefined();
  });

  it('refuses a socket count other than one', () => {
    expect(() => inheritedSocketFd({ LISTEN_FDS: '2', LISTEN_PID: '4242' }, 4242)).toThrow(/LISTEN_FDS=2/);
  });
});

describe('isUnixListener', () => {
  // Shapes observed from node:http under systemd-socket-activate.
  it('accepts an inherited unix fd (null) or a bound path (string)', () => {
    expect(isUnixListener(null)).toBe(true);
    expect(isUnixListener('/run/wander-api.sock')).toBe(true);
  });

  it('rejects a TCP listener', () => {
    expect(isUnixListener({ address: '127.0.0.1', family: 'IPv4', port: 3700 })).toBe(false);
  });
});
