import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Reclaim on SIGHUP, SIGTERM and SIGINT; yield to Pi's suspend handler, but not signal-exit.
export const shutdownReclaimMarker = Symbol.for('fodh.shutdownReclaim');
type ReclaimHandler = (() => void) & { [shutdownReclaimMarker]?: true };
const installed = new Set<Map<NodeJS.Signals, ReclaimHandler>>();
export function ensureShutdownReclaimFirst(): string[] {
  const moved = new Set<string>();
  for (const handlers of installed) for (const [signal, handler] of handlers) {
    const listeners = process.rawListeners(signal);
    if (listeners.includes(handler) && listeners[0] !== handler) {
      process.off(signal, handler); process.prependListener(signal, handler); moved.add(signal);
    }
  }
  return [...moved];
}
export function installShutdownReclaim(getGroup: () => number | undefined, getRoot: () => string = () => process.cwd()): () => void {
  const handlers = new Map<NodeJS.Signals, ReclaimHandler>();
  const uninstall = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    installed.delete(handlers);
  };
  // Pi registerSignalHandlers prepends listeners after extension load and may exit synchronously.
  // session_start reinstalls us first; the turn guard repairs later Pi registration as well.
  // signal-exit v3/v4 listeners are cleanup/re-signal plumbing, not Pi's temporary SIGINT ignore handler.
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    const handler: ReclaimHandler = () => {
      if (signal === 'SIGINT') {
        const signalExitKey = Symbol.for('signal-exit emitter');
        const signalProcess = process as typeof process & {
          __signal_exit_emitter__?: { count: number }; [signalExitKey]?: { count: number };
        };
        const signalExitCount = (signalProcess.__signal_exit_emitter__?.count ?? 0) + (signalProcess[signalExitKey]?.count ?? 0);
        const otherCount = process.listeners(signal).filter(listener => !(listener as ReclaimHandler)[shutdownReclaimMarker]).length;
        if (otherCount - signalExitCount > 0) return;
      }
      const pgid = getGroup();
      if (pgid && Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid) {
        for (const killSignal of ['SIGTERM', 'SIGKILL'] as const) {
          try { process.kill(-pgid, killSignal); } catch { /* Already gone or no permission; startup checks remaining ownership. */ }
        }
        try { writeFileSync(join(getRoot(), '.pi/harness-brain-orphan.json'), JSON.stringify({ pgid, signal, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
        catch { /* Signal termination cannot wait for filesystem recovery. */ }
      }
      uninstall();
      process.kill(process.pid, signal);
    };
    handler[shutdownReclaimMarker] = true;
    handlers.set(signal, handler); process.prependListener(signal, handler);
  }
  installed.add(handlers);
  return uninstall;
}
