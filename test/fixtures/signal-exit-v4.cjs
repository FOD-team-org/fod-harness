// Minimal v4 SIGINT contract: global emitter, v3 count included, unload then re-signal.
const emitter = globalThis[Symbol.for('signal-exit emitter')] ??= { count: 0 };
exports.onExit = callback => {
  emitter.count++;
  const unload = () => { process.off('SIGINT', handler); emitter.count--; };
  const handler = () => {
    const count = emitter.count + (process.__signal_exit_emitter__?.count ?? 0);
    if (process.listenerCount('SIGINT') !== count) return;
    unload(); callback(null, 'SIGINT'); process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', handler);
  return unload;
};
