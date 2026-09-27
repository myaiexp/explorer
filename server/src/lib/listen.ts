// Listener choice — systemd's inherited proxy socket, or loopback TCP.
//
// Production: wander-api.socket owns /run/wander-api.sock (0660 root:www-data)
// and passes it down as fd 3, so the uid boundary is the socket file's mode,
// not a TCP port every local uid can reach (finding #10094). Dev and tests
// bind 127.0.0.1:PORT and never trust forwarding headers there.

// sd_listen_fds(3): the first passed fd is always 3.
const SD_LISTEN_FDS_START = 3;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The inherited socket fd, or undefined when systemd passed none. LISTEN_PID
 * must name this process — an env var inherited by some unrelated child is
 * not a socket handed to us.
 */
export function inheritedSocketFd(env: Env, pid: number): number | undefined {
  if (!env.LISTEN_FDS) return undefined;
  if (env.LISTEN_PID !== String(pid)) return undefined;
  const count = Number(env.LISTEN_FDS);
  if (count !== 1) {
    throw new Error(`expected exactly one socket from systemd, got LISTEN_FDS=${env.LISTEN_FDS}`);
  }
  return SD_LISTEN_FDS_START;
}

/**
 * Whether a listening server is bound to a unix socket. Node reports a TCP
 * listener as an address object and an inherited unix fd as null (a string
 * when it bound the path itself). Checked after listen() so a socket unit
 * edited to ListenStream=<port> fails the start instead of silently trusting
 * forwarding headers from every local uid.
 */
export function isUnixListener(address: unknown): boolean {
  return address === null || typeof address === 'string';
}
