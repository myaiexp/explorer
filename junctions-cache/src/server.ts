// Compat bootstrap for systemd ExecStart=dist/server.js. Delegates to index.ts
// so a unit that hasn't been pointed at dist/index.js still starts.
import './index.js';
