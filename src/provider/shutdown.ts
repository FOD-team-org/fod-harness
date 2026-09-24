import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pi handles SIGINT itself (interactive-mode.js); do not intercept it here.
export function installShutdownReclaim(getGroup: () => number | undefined, getRoot: () => string = () => process.cwd()): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    const handler = () => {
      const pgid = getGroup();
      if (pgid && Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid) {
        for (const killSignal of ['SIGTERM', 'SIGKILL'] as const) {
          try { process.kill(-pgid, killSignal); } catch { /* Already gone or no permission; startup checks remaining ownership. */ }
        }
        try { writeFileSync(join(getRoot(), '.pi/harness-brain-orphan.json'), JSON.stringify({ pgid, signal, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
        catch { /* Signal termination cannot wait for filesystem recovery. */ }
      }
      // once has removed this handler; preserve exitCode and continue signal handling.
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler); process.once(signal, handler);
    // Pi's pre-existing SIGHUP listener exits synchronously. Keep its behavior,
    // but run our once wrapper first so the brain cannot outlive that exit.
    const once = process.rawListeners(signal).at(-1)! as NodeJS.SignalsListener;
    process.off(signal, handler); process.prependListener(signal, once);
  }
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}
